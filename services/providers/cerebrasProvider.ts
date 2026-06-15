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

import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { Content, Part } from "@google/genai";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { trace } from '../../utils/logger.js';
import type { AIProvider, InitSessionOptions, TurnResult } from './types.js';

/** Read a numeric env var, falling back when unset/blank/invalid (0 is honored). */
const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const DEFAULT_MODEL = 'gemma-4-31b-trial';
/** Safety cap on the agentic tool-calling loop to avoid runaway iterations. */
const MAX_TOOL_ITERATIONS = 10;

// Per-request limits. These shift between private preview and public availability,
// so they're env-configurable (with sensible preview defaults).
//   CEREBRAS_MAX_IMAGES      — images per request (default 5)
//   CEREBRAS_MAX_PAYLOAD_MB  — total image payload budget per request (default 10)
const MAX_IMAGES = envNum('CEREBRAS_MAX_IMAGES', 5);
const MAX_PAYLOAD_MB = envNum('CEREBRAS_MAX_PAYLOAD_MB', 10);
const MAX_PAYLOAD_BYTES = MAX_PAYLOAD_MB * 1024 * 1024;

// Generation settings. Defaults follow Cerebras' recommendation for Gemma at
// `reasoning_effort: medium` (competitive with Gemini): temperature 0.8, top_p 0.95.
// All are env-overridable for A/B experimentation during the preview.
const REASONING_EFFORT = (process.env.CEREBRAS_REASONING_EFFORT || 'medium').toLowerCase();
const TEMPERATURE = envNum('CEREBRAS_TEMPERATURE', 0.8);
const TOP_P = envNum('CEREBRAS_TOP_P', 0.95);
// Strict tool calling (constrained decoding) is recommended for reliable tool use.
// Toggle off via CEREBRAS_STRICT_TOOLS=false if a tool schema ever trips it up.
const STRICT_TOOLS = (process.env.CEREBRAS_STRICT_TOOLS || 'true').toLowerCase() !== 'false';

// Loosely-typed OpenAI-style message; the SDK's strict unions are cast at the call site.
type ChatMessage = Record<string, any>;
type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: any; strict?: boolean } };

/** Best-effort JSON parse of a tool-call arguments string. */
const safeParseArgs = (raw: string | undefined): any => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    trace(`[Cerebras] Failed to parse tool arguments: ${raw?.substring(0, 200)}`);
    return {};
  }
};

/**
 * Recursively prepare a JSON Schema for Cerebras strict-mode (constrained decoding):
 *   - drop the `format` keyword and `x-*` / `$schema` vendor keywords, which the
 *     constrained decoder rejects (verified: it 400s on `format: "double"` etc.),
 *   - set `additionalProperties: false` on every object node (incl. `$defs`).
 * `required` is left as-is: Cerebras does NOT require all properties to be listed,
 * and keeping it intact preserves optional tool params and yields cleaner tool args.
 */
const toStrictParameters = (schema: any): any => {
  const cloned = JSON.parse(JSON.stringify(schema ?? { type: 'object', properties: {} }));
  const walk = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;

    delete node.format;
    for (const key of Object.keys(node)) {
      if (key.startsWith('x-') || key === '$schema') delete node[key];
    }
    if (node.type === 'object' && node.properties) {
      node.additionalProperties = false;
    }
    if (node.properties) Object.values(node.properties).forEach(walk);
    if (node.$defs) Object.values(node.$defs).forEach(walk);
    if (node.items) walk(node.items);
    for (const comb of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(node[comb])) node[comb].forEach(walk);
    }
  };
  walk(cloned);
  return cloned;
};

/**
 * Strip the model's chain-of-thought before storing an assistant turn in history.
 * The Gemma model card recommends NOT feeding reasoning back in multi-turn loops;
 * only the final content (and any tool_calls) should be retained.
 */
const toHistoryMessage = (message: any): ChatMessage => {
  const historyMsg: ChatMessage = { role: message.role || 'assistant' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    historyMsg.tool_calls = message.tool_calls;
  }
  // Assistant tool-call turns may carry null content; keep content for final answers.
  if (message.content != null) historyMsg.content = message.content;
  else if (!historyMsg.tool_calls) historyMsg.content = '';
  return historyMsg;
};

/**
 * Validate a base64 image data URL against Cerebras' supported formats (PNG/JPEG
 * only — no WebP/GIF/HEIC, no HTTPS URLs). The format is detected by sniffing the
 * decoded magic bytes rather than trusting the `data:` mime label (extensions and
 * labels are often wrong, e.g. WebP saved as .png), and the returned data URL is
 * re-stamped with the detected mime. Throws a clear error for unsupported input so
 * callers don't get Cerebras' opaque "400 Image data could not be decoded".
 */
const normalizeImageDataUrl = (url: string): string => {
  const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(url || '');
  if (!match || !match[2]) {
    throw new Error("Image must be a base64-encoded data URL (data:image/png;base64,...). HTTPS image URLs are not supported by Cerebras.");
  }
  const b64 = match[3];
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  let mime: string | null = null;
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    mime = 'image/png';
  } else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    mime = 'image/jpeg';
  }
  if (!mime) {
    throw new Error("Unsupported image format: Gemma on Cerebras accepts only base64 PNG or JPEG. The provided image is an unrecognized or unsupported format (e.g. WebP, GIF, or HEIC).");
  }
  return `data:${mime};base64,${b64}`;
};

/** Extract the text payload from an MCP CallToolResult to feed back to the model. */
const extractToolText = (mcpResult: any): string => {
  if (mcpResult && Array.isArray(mcpResult.content)) {
    const text = mcpResult.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
    if (text) return text;
  }
  // Fallback: stringify whatever we got so the model still sees something.
  return JSON.stringify(mcpResult ?? {});
};

/**
 * Cerebras / Gemma provider.
 *
 * Cerebras' chat completions API is OpenAI-compatible but has no equivalent of
 * Gemini's `mcpToTool` auto-loop, so this provider:
 *   1. converts MCP tools -> OpenAI function tool definitions,
 *   2. runs the agentic loop manually (call -> execute via MCP -> feed result -> repeat),
 *   3. adapts the OpenAI-style turn back into the Gemini `Content[]` shape so the
 *      facade post-processing and the frontend remain unchanged.
 */
export class CerebrasProvider implements AIProvider {
  readonly modelName: string;
  readonly displayName = 'Gemma';
  readonly limits = { maxImages: MAX_IMAGES, maxPayloadMb: MAX_PAYLOAD_MB };

  private client: Cerebras | null = null;
  private mcpClient: McpClient | null = null;
  private tools: OpenAITool[] = [];
  /** Persistent OpenAI-style conversation history (mirrors Gemini's stateful Chat). */
  private messages: ChatMessage[] = [];

  constructor() {
    this.modelName = process.env.CEREBRAS_MODEL || DEFAULT_MODEL;
  }

  isInitialized(): boolean {
    return !!this.client;
  }

  async initSession({ mcpClient, systemInstruction, initialHistory }: InitSessionOptions): Promise<void> {
    const apiKey = process.env.CEREBRAS_API_KEY;
    if (!apiKey) {
      throw new Error("CEREBRAS_API_KEY environment variable is not set for Cerebras API calls.");
    }

    if (!this.client) {
      trace("[Cerebras] Initializing Cerebras client...");
      this.client = new Cerebras({ apiKey });
    }

    this.mcpClient = mcpClient;

    // Convert MCP tools -> OpenAI function tool format (optionally strict-mode).
    const listed = await mcpClient.listTools();
    this.tools = (listed.tools || []).map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: STRICT_TOOLS
          ? toStrictParameters(t.inputSchema)
          : (t.inputSchema || { type: 'object', properties: {} }),
        ...(STRICT_TOOLS ? { strict: true } : {}),
      },
    }));
    trace(`[Cerebras] Converted ${this.tools.length} MCP tool(s) to OpenAI format (strict=${STRICT_TOOLS}): ${this.tools.map(t => t.function.name).join(', ')}`);

    // Seed history with the system instruction, then any prior turns.
    this.messages = [{ role: 'system', content: systemInstruction }];
    for (const c of initialHistory || []) {
      const text = (c.parts || []).map((p: Part) => p.text).filter(Boolean).join('\n');
      if (text) {
        this.messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
      }
    }

    trace("[Cerebras] Chat session initialized with MCP tools.");
  }

  async sendMessage(userMessageContent: string, images?: string[]): Promise<TurnResult> {
    if (!this.client || !this.mcpClient) {
      throw new Error("Cerebras provider is not initialized.");
    }

    // Build the user message. With images, use the multimodal content-parts form
    // (base64 data URLs only, capped at MAX_IMAGES); otherwise a plain string.
    const imgs = (images || []).slice(0, MAX_IMAGES);
    if (images && images.length > MAX_IMAGES) {
      trace(`[Cerebras] ${images.length} images provided; truncating to ${MAX_IMAGES}.`);
    }
    if (imgs.length > 0) {
      // Validate/normalize each image to a supported base64 PNG/JPEG data URL.
      const normalized = imgs.map(normalizeImageDataUrl);
      // Enforce the per-request payload budget (the base64 data URLs dominate the body).
      const totalBytes = normalized.reduce((sum, url) => sum + url.length, 0);
      if (totalBytes > MAX_PAYLOAD_BYTES) {
        throw new Error(`Image payload too large: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${MAX_PAYLOAD_MB} MB per-request limit. Attach fewer or smaller images.`);
      }
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userMessageContent },
          ...normalized.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    } else {
      this.messages.push({ role: 'user', content: userMessageContent });
    }

    // turnContent mirrors what Gemini's getHistory() diff would produce for this turn.
    const turnContent: Content[] = [{ role: 'user', parts: [{ text: userMessageContent }] }];
    let finalText = "";

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const completion: any = await this.client.chat.completions.create({
        model: this.modelName,
        messages: this.messages as any,
        tools: this.tools.length > 0 ? (this.tools as any) : undefined,
        tool_choice: this.tools.length > 0 ? 'auto' : undefined,
        temperature: TEMPERATURE,
        top_p: TOP_P,
        reasoning_effort: REASONING_EFFORT,
      } as any);

      const message = completion?.choices?.[0]?.message;
      if (!message) {
        throw new Error("Cerebras returned no message in completion.");
      }

      // Keep the assistant turn (tool_calls / final content) in history, but strip
      // the chain-of-thought per the Gemma multi-turn recommendation.
      this.messages.push(toHistoryMessage(message));

      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Record the model's tool-call request as Gemini functionCall parts.
        const callParts: Part[] = toolCalls.map((tc: any) => ({
          functionCall: {
            name: tc.function?.name || 'unknown-tool',
            args: safeParseArgs(tc.function?.arguments),
          },
        }));
        turnContent.push({ role: 'model', parts: callParts });

        // Execute each tool via the MCP client (status updates fire through the
        // facade's wrapped callTool), then feed results back to the model.
        const responseParts: Part[] = [];
        for (const tc of toolCalls) {
          const name = tc.function?.name || 'unknown-tool';
          const args = safeParseArgs(tc.function?.arguments);
          trace(`[MCP] Found function call: ${name}`);

          let mcpResult: any;
          try {
            mcpResult = await this.mcpClient.callTool({ name, arguments: args });
          } catch (e) {
            trace(`[Cerebras] Tool '${name}' execution failed:`, e);
            mcpResult = {
              content: [{ type: 'text', text: JSON.stringify({ failure: String(e) }) }],
              isError: true,
            };
          }

          // Feed the raw tool text back to the model for the next iteration.
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: extractToolText(mcpResult),
          });

          // Record the result in Gemini shape. `response` MUST be the raw MCP
          // CallToolResult so downstream parsing (frontend + facade) works.
          responseParts.push({
            functionResponse: { name, response: mcpResult },
          });
        }
        turnContent.push({ role: 'function', parts: responseParts });
        continue; // Re-prompt the model with the tool results.
      }

      // No tool calls -> final assistant answer.
      finalText = typeof message.content === 'string' ? message.content : "";
      turnContent.push({ role: 'model', parts: [{ text: finalText }] });
      return { response: { text: finalText }, turnContent };
    }

    // Loop exhausted without a final text answer.
    trace(`[Cerebras] Tool loop reached MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS}).`);
    return { response: { text: finalText }, turnContent };
  }
}
