import { z } from "zod";
import { ProjectSchema, Id } from "../core/project.ts";
import { ProjectStore } from "../core/store.ts";
import { RenderQueue } from "../core/render.ts";
const tools = {
  "darzain.project.create": z
    .object({ name: z.string().min(1).max(120) })
    .strict(),
  "darzain.project.open": z.object({ projectId: Id }).strict(),
  "darzain.project.list": z.object({}).strict(),
  "darzain.project.save": z
    .object({
      project: ProjectSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  "darzain.export.video": z
    .object({ projectId: Id, idempotencyKey: z.string().min(1).max(80) })
    .strict(),
  "darzain.job.status": z.object({ jobId: Id }).strict(),
  "darzain.job.cancel": z.object({ jobId: Id }).strict(),
  "darzain.job.list": z.object({}).strict(),
};
export class CreativeAPI {
  readonly store: ProjectStore;
  readonly queue: RenderQueue;
  constructor(store: ProjectStore) {
    this.store = store;
    this.queue = new RenderQueue(store);
  }
  catalog() {
    return {
      apiVersion: 1,
      tools: Object.entries(tools).map(([name, schema]) => ({
        name,
        inputSchema: z.toJSONSchema(schema),
      })),
      assetImport: {
        method: "POST",
        path: "/api/v1/projects/{id}/assets",
        body: "raw media bytes",
        nameHeader: "X-Asset-Name",
        maxBytes: 50 * 1024 * 1024,
      },
    };
  }
  async call(name: string, args: unknown) {
    if (!Object.hasOwn(tools, name)) throw new Error("Unknown tool.");
    const schema = tools[name as keyof typeof tools];
    const a: any = schema.parse(args);
    switch (name) {
      case "darzain.project.create":
        return this.store.create(a.name);
      case "darzain.project.open":
        return this.store.load(a.projectId);
      case "darzain.project.list":
        return this.store.list();
      case "darzain.project.save":
        return this.store.save(a.project, a.expectedRevision);
      case "darzain.export.video":
        return this.queue.submit(a.projectId, a.idempotencyKey);
      case "darzain.job.status":
        return this.queue.status(a.jobId);
      case "darzain.job.cancel":
        return this.queue.cancel(a.jobId);
      case "darzain.job.list":
        return this.queue.list();
    }
  }
}
