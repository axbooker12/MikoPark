// The "Would you like more information" follow-up that agents add after answering a question.
// Agents are told to write it as the last line; the web client turns it into a button.

export const FOLLOW_UP_PREFIX = "Would you like more information:";

/** Max paragraphs an agent writes in a normal chat reply (task deliverables are exempt). */
export const MAX_REPLY_PARAGRAPHS = 3;

const LINE = /^[\s>*_]*would you like more information\s*[:\-–—]\s*(.+?)[\s?*_.]*$/i;

/** Splits a reply into its body and the follow-up topic, if the last line is a follow-up prompt. */
export function splitFollowUp(content: string): { body: string; topic: string | null } {
  const lines = content.trimEnd().split("\n");
  const match = LINE.exec(lines.at(-1) ?? "");
  const topic = match?.[1].replace(/^[("'“]+|[)"'”]+$/g, "").trim();
  if (!topic) return { body: content, topic: null };
  return { body: lines.slice(0, -1).join("\n").trimEnd(), topic };
}

/** The message sent when someone clicks the follow-up button. */
export function followUpRequest(topic: string, agentName: string, inChannel: boolean): string {
  return `${inChannel ? `@${agentName} ` : ""}Yes, please give me more information on: ${topic}`;
}
