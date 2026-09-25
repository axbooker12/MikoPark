// The Claude models people can pick in the composer, and how each one is called.

export type Effort = "low" | "medium" | "high" | "xhigh";

export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
  /** Adaptive thinking + the effort parameter. Haiku 4.5 supports neither. */
  adaptive: boolean;
  /** Server-side refusal fallbacks (the "default" routing mode). */
  fallbacks: boolean;
  /** Newer web tools with dynamic filtering; older models use the basic versions. */
  webTools: "2026" | "2025";
  maxTokens: number;
}

export const MODELS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    blurb: "Newest Opus. Top quality for most work.",
    adaptive: true,
    fallbacks: true,
    webTools: "2026",
    maxTokens: 64000,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    blurb: "Previous Opus. Strong all-rounder.",
    adaptive: true,
    fallbacks: true,
    webTools: "2026",
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "Fast and capable. Great for everyday chat.",
    adaptive: true,
    fallbacks: false,
    webTools: "2026",
    maxTokens: 64000,
  },
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    blurb: "Most capable. Best for the hardest problems; slower and pricier.",
    adaptive: true,
    fallbacks: true,
    webTools: "2026",
    maxTokens: 64000,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    blurb: "Fastest and cheapest. Quick answers, lighter reasoning.",
    adaptive: false,
    fallbacks: false,
    webTools: "2025",
    maxTokens: 32000,
  },
];

export const EFFORTS: { id: Effort; label: string; blurb: string }[] = [
  { id: "low", label: "Quick", blurb: "Fastest replies, least thinking" },
  { id: "medium", label: "Balanced", blurb: "Good for most conversations" },
  { id: "high", label: "Deep", blurb: "Thinks harder before answering" },
  { id: "xhigh", label: "Deepest", blurb: "Most thorough; slowest" },
];

export const DEFAULT_MODEL = "claude-opus-5";

export function findModel(id: string | undefined): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

/** A readable name for any model id, including ones not in the picker. */
export function modelLabel(id: string): string {
  return findModel(id)?.label ?? id;
}
