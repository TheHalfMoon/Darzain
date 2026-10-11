import { ProjectStore } from "../core/store.ts";
import { RenderQueue } from "../core/render.ts";
import {
  API_VERSION,
  Scopes,
  catalog,
  execute,
} from "../core/command/registry.ts";
import type { Principal } from "../core/command/registry.ts";
import {
  RESOURCE_POLICY,
  RESOURCE_POLICY_HASH,
} from "../core/command/policy.ts";

// MVP trust model: one local account. Both principals hold the MVP scopes, but
// they authenticate through separate credentials and are audited separately.
export const principals: Record<Principal["id"], Principal> = {
  "browser-ui": { id: "browser-ui", scopes: new Set(Scopes) },
  "local-client": { id: "local-client", scopes: new Set(Scopes) },
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
      apiVersion: API_VERSION,
      service: "yamakan",
      resourcePolicy: { ...RESOURCE_POLICY, hash: RESOURCE_POLICY_HASH },
      tools: catalog(),
      assetImport: {
        method: "POST",
        path: "/api/v1/projects/{id}/assets",
        body: "raw media bytes",
        nameHeader: "X-Asset-Name",
        maxBytes: RESOURCE_POLICY.enforced.assetImportBytes,
      },
    };
  }
  async call(
    name: unknown,
    args: unknown,
    principal: Principal = principals["local-client"],
    requestId?: string,
  ) {
    const { result } = await execute(
      { store: this.store, queue: this.queue, principal, requestId },
      name,
      args,
    );
    return result;
  }
}
