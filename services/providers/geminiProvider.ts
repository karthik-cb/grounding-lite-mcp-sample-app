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

import {
  GoogleGenAI,
  Chat,
  GenerateContentResponse,
  Content,
  HarmCategory,
  HarmBlockThreshold,
  mcpToTool,
  FinishReason,
  FunctionCall,
} from "@google/genai";
import { trace } from '../../utils/logger.js';
import type { AIProvider, InitSessionOptions, TurnResult } from './types.js';

const MODEL_NAME = 'gemini-2.5-flash-preview-09-2025';

/**
 * Gemini provider: preserves the original `@google/genai` integration, which
 * uses `ai.chats.create` + `mcpToTool` to automatically run the MCP tool loop.
 */
export class GeminiProvider implements AIProvider {
  readonly modelName = MODEL_NAME;
  readonly displayName = 'Gemini';

  private ai: GoogleGenAI | null = null;
  private chat: Chat | null = null;

  isInitialized(): boolean {
    return !!this.ai && !!this.chat;
  }

  async initSession({ mcpClient, systemInstruction, initialHistory }: InitSessionOptions): Promise<void> {
    const serverApiKey = process.env.SERVER_API_KEY;
    if (!serverApiKey) {
      throw new Error("SERVER_API_KEY environment variable is not set for Gemini API calls.");
    }

    if (!this.ai) {
      trace("[Gemini] Initializing GoogleGenAI client...");
      this.ai = new GoogleGenAI({ apiKey: serverApiKey });
    }

    // Connect Gemini directly to the remote Google Maps MCP server.
    const toolsForGemini = [mcpToTool(mcpClient)];
    trace(`[Gemini] Tools (from MCP): ${toolsForGemini.length} tool(s) configured.`);

    this.chat = this.ai.chats.create({
      model: MODEL_NAME,
      history: initialHistory || [],
      config: {
        temperature: 0.6,
        thinkingConfig: {
          thinkingBudget: 512,
        },
        systemInstruction,
        tools: toolsForGemini.length > 0 ? toolsForGemini : undefined,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
        ],
      },
    });

    trace("[Gemini] Chat session initialized with MCP tools.");
  }

  async sendMessage(userMessageContent: string, _images?: string[]): Promise<TurnResult> {
    if (!this.chat) {
      throw new Error("Gemini chat session is not available.");
    }

    // Image inputs are not wired into the Gemini path yet (backend-swap scope);
    // they are only consumed by the Cerebras provider for now.

    const historyBefore = await this.chat.getHistory();
    const historyBeforeLength = historyBefore.length;

    const response = await this.chat.sendMessage({ message: userMessageContent });

    // Handle safety blocks: surface a friendly message and skip tool processing.
    if (response.candidates && response.candidates.length > 0 && response.candidates[0].finishReason === 'SAFETY') {
      const safetyMessage = "The response was blocked because it was flagged for safety reasons. This can sometimes happen with general queries. Please try rephrasing your request to be more specific.";

      const safeResponse: GenerateContentResponse = {
        ...response,
        candidates: [
          {
            ...(response.candidates[0] || {}),
            finishReason: FinishReason.STOP,
            content: { parts: [{ text: safetyMessage }], role: 'model' },
          },
        ],
        text: safetyMessage,
        functionCalls: [] as FunctionCall[],
        data: "",
        executableCode: "",
        codeExecutionResult: "",
      };

      const historyAfter = await this.chat.getHistory();
      const turnContent = historyAfter.slice(historyBeforeLength);
      return { response: safeResponse as unknown as TurnResult['response'], turnContent, blocked: true };
    }

    // The chat's history now contains the full turn (user msg, tool calls/responses, model reply).
    const historyAfter = await this.chat.getHistory();
    const turnContent: Content[] = historyAfter.slice(historyBeforeLength);

    // The SDK response uses getters that don't survive JSON serialization; extract text explicitly.
    let textContent = "";
    try {
      // @ts-ignore: response.text may be a getter or a method depending on SDK version
      textContent = typeof response.text === 'function' ? response.text() : response.text;
    } catch (e) {
      trace("[Gemini] Could not extract text from response:", e);
    }

    const serializableResponse = { ...response, text: textContent || "" };
    return { response: serializableResponse as unknown as TurnResult['response'], turnContent };
  }
}
