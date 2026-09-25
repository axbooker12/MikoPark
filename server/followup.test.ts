import { describe, expect, it } from "vitest";
import { followUpRequest, splitFollowUp } from "../shared/followup.ts";
import { systemPrompt } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";
import type { Agent, Channel } from "../shared/types.ts";

describe("splitFollowUp", () => {
  it("pulls the topic off the last line", () => {
    expect(splitFollowUp("Answer here.\n\nWould you like more information: pricing tiers?")).toEqual({
      body: "Answer here.",
      topic: "pricing tiers",
    });
  });
  it("tolerates markdown, missing question marks and quotes", () => {
    expect(splitFollowUp("A\n**Would you like more information: \"launch timeline\"**").topic).toBe("launch timeline");
    expect(splitFollowUp("A\n_would you like more information - SEO basics_").topic).toBe("SEO basics");
  });
  it("ignores replies without the line, or with it mid-reply", () => {
    expect(splitFollowUp("Just an answer.").topic).toBeNull();
    expect(splitFollowUp("Would you like more information: x?\nMore text").topic).toBeNull();
  });
  it("builds the reply, mentioning the agent only in channels", () => {
    expect(followUpRequest("SEO", "Wren", true)).toBe("@Wren Yes, please give me more information on: SEO");
    expect(followUpRequest("SEO", "Wren", false)).toBe("Yes, please give me more information on: SEO");
  });
});

describe("reply length rules", () => {
  it("are part of every agent's system prompt", () => {
    const store = new Store(null);
    const { stable } = systemPrompt(store, store.workspace.agents[0], store.channel("c_general")!);
    expect(stable).toContain("3 short paragraphs at most");
    expect(stable).toContain("Would you like more information:");
  });
  it("are lifted for task deliverables", async () => {
    const store = new Store(null);
    let brief = "";
    const team = new Team(store, {
      mode: "demo",
      async reply(_a: Agent, _c: Channel, sink, extra) {
        brief = extra ?? "";
        sink.delta("done");
      },
    });
    const kai = store.hireAgent("engineer");
    const t = store.createTask({ title: "Build it", assigneeAgentId: kai.id, createdBy: { kind: "human", id: "u_me" } });
    await team.startTask(t.id);
    expect(brief).toContain("length limit");
  });
});
