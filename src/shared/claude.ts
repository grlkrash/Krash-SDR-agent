import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

type MockHandler = (args: MessageCreateParams) => Promise<unknown>;

let mockHandler: MockHandler | null = null;

export const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const originalCreate = claude.messages.create.bind(claude.messages);

claude.messages.create = ((args: MessageCreateParams, options?: unknown) => {
  if (mockHandler !== null) return mockHandler(args);
  return originalCreate(args as never, options as never);
}) as typeof claude.messages.create;

export const setClaudeMock = (handler: MockHandler | null): void => {
  mockHandler = handler;
};

export const extractText = (msg: Message): string =>
  msg.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');

export const extractJSON = <T>(msg: Message): T => {
  const raw = extractText(msg).replace(/^```json\n?|\n?```$/g, '').trim();
  return JSON.parse(raw) as T;
};
