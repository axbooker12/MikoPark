import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Attachment, AttachmentKind } from "../shared/types.ts";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown csv tsv json jsonl yaml yml toml ini xml html htm css scss js jsx ts tsx mjs cjs py rb go rs java kt " +
    "swift c h cc cpp hpp cs php sql sh bash zsh ps1 r lua pl scala dart vue svelte log conf cfg properties gitignore dockerfile makefile"
  ).split(" "),
);

export function classify(name: string, type: string): AttachmentKind {
  if (IMAGE_TYPES.has(type)) return "image";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json" || type === "application/xml" || TEXT_EXTENSIONS.has(ext)) return "text";
  const base = name.toLowerCase().split("/").pop() ?? "";
  if (base === "dockerfile" || base === "makefile") return "text";
  return "other";
}

/** Stores uploaded files on disk (or in memory when there is no data directory, e.g. in tests). */
export class UploadStore {
  private memory = new Map<string, { meta: Attachment; data: Buffer }>();

  constructor(private dir: string | null) {}

  save(input: { name: string; type: string; data: Buffer; path?: string }): Attachment {
    if (!input.data.length) throw new Error("File is empty");
    if (input.data.length > MAX_UPLOAD_BYTES) throw new Error(`${input.name} is larger than 25 MB`);
    const name = path.basename(input.name.replace(/\\/g, "/")).slice(0, 200) || "file";
    const type = input.type || "application/octet-stream";
    const meta: Attachment = {
      id: randomBytes(12).toString("hex"),
      name,
      type,
      size: input.data.length,
      kind: classify(name, type),
      ...(input.path ? { path: input.path.replace(/\\/g, "/").slice(0, 500) } : {}),
    };
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, meta.id), input.data);
      fs.writeFileSync(path.join(this.dir, `${meta.id}.json`), JSON.stringify(meta));
    } else {
      this.memory.set(meta.id, { meta, data: input.data });
    }
    return meta;
  }

  meta(id: string): Attachment | undefined {
    if (!/^[a-f0-9]{24}$/.test(id)) return undefined;
    if (!this.dir) return this.memory.get(id)?.meta;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as Attachment;
    } catch {
      return undefined;
    }
  }

  read(id: string): { meta: Attachment; data: Buffer } | undefined {
    const meta = this.meta(id);
    if (!meta) return undefined;
    if (!this.dir) return this.memory.get(id);
    try {
      return { meta, data: fs.readFileSync(path.join(this.dir, id)) };
    } catch {
      return undefined;
    }
  }
}
