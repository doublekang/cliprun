// Shared TypeScript types for ClipRun

export interface Snippet {
  id: string;
  text: string;
  createdAt: number;
}

export interface SnippetStore {
  schemaVersion: number;
  snippets: Snippet[];
}

export interface Message {
  type: string;
  payload?: unknown;
}