/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Content } from "@google/genai";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client";

/**
 * Options passed to a provider when (re)initializing a chat session.
 */
export interface InitSessionOptions {
  /** The connected remote MCP client. Tools are listed/executed through this. */
  mcpClient: McpClient;
  /** The full system instruction (already includes the current date/time prefix). */
  systemInstruction: string;
  /** Optional prior history to seed the session with (Gemini Content[] shape). */
  initialHistory?: Content[];
}

/**
 * The result of a single conversational turn.
 *
 * IMPORTANT CONTRACT: `turnContent` MUST be in the Gemini `Content[]` shape, where
 * tool calls appear as `{ role: 'model', parts: [{ functionCall: { name, args } }] }`
 * and tool results as `{ role: 'function', parts: [{ functionResponse: { name, response } }] }`.
 * `functionResponse.response` MUST be the raw MCP `CallToolResult`
 * (`{ content: [{ type: 'text', text: '<JSON>' }] }`).
 *
 * This is what `conversationalAIService.sendMessageToAI` and the frontend
 * (`chat-app.ts`) post-processing both expect, so every provider must conform
 * to it regardless of the underlying model API.
 */
export interface TurnResult {
  /** The final assistant text plus any extra fields the provider wishes to surface. */
  response: { text: string } & Record<string, unknown>;
  /** The turn rendered in Gemini Content[] shape (see contract above). */
  turnContent: Content[];
  /** Set when the model declined/blocked the response; skips tool-exchange building. */
  blocked?: boolean;
}

/**
 * A pluggable conversational AI backend (e.g. Gemini, Cerebras/Gemma).
 * The facade in `conversationalAIService.ts` owns MCP setup, the system prompt,
 * session management and tool-exchange post-processing; a provider only owns
 * the model call and the agentic tool-calling loop.
 */
export interface AIProvider {
  /** Human-facing model id, shown in the UI and returned by initChatSession. */
  readonly modelName: string;
  /** Short provider label used in status messages, e.g. "Gemini" / "Gemma". */
  readonly displayName: string;
  /** Create a fresh chat session bound to the given MCP client and system prompt. */
  initSession(opts: InitSessionOptions): Promise<void>;
  /** Send one user turn (optional base64 image data URLs) and return its result. */
  sendMessage(userMessageContent: string, images?: string[]): Promise<TurnResult>;
  /** Whether the underlying client has been initialized. */
  isInitialized(): boolean;
}
