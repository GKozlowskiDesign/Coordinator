// src/ai-models.ts
export type AiModel = {
  id: string;
  name: string;
  vrmGb: number;
  description: string;
  priceLamports: number;     // e.g. 0.01 SOL = 10_000_000
  engine: 'ollama' | 'stub';
  engineId: string;          // e.g. "llama3.1:8b-instruct-q4"
};

export const AI_MODELS: AiModel[] = [
  {
    id: 'llama-3.1-8b-q4',
    name: 'Llama 3.1 8B Instruct (Q4)',
    vrmGb: 7,
    description: 'General-purpose chat / coding on a single 3090.',
    priceLamports: 10_000_000, // 0.01 SOL
    engine: 'ollama',
    engineId: 'llama3.1-8b-instruct-q4',
  },
  {
    id: 'mistral-7b-q4',
    name: 'Mistral 7B Instruct (Q4)',
    vrmGb: 6,
    description: 'Fast, light-weight assistant tuned for reasoning.',
    priceLamports: 10_000_000,
    engine: 'ollama',
    engineId: 'mistral:7b-instruct-q4',
  },
  // add more later
];
