import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import {
  API_VERSION,
  RESOURCE_POLICY_HASH,
  Scopes,
  catalog,
  execute,
} from "../core/command/registry.ts";
import type { Principal } from "../core/command/registry.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";
import { ownershipMode } from "../core/process/owner.ts";

// MVP trust model: one local account. Both principals hold the MVP scopes, but
// they authenticate through separate credentials.
export const principals: Record<Principal["id"], Principal> = {
  "browser-ui": { id: "browser-ui", scopes: new Set(Scopes) },
  "local-client": { id: "local-client", scopes: new Set(Scopes) },
};

export class CreativeAPI {
  readonly store: ProjectStore;
  readonly queue: JobSupervisor;
  constructor(store: ProjectStore) {
    this.store = store;
    this.queue = new JobSupervisor(store);
  }
  catalog() {
    return {
      apiVersion: API_VERSION,
      service: "yamakan",
      // How media workers are owned on this host; only Windows is qualified.
      processOwnership: ownershipMode(),
      // Only enforced limits are advertised; candidates are unqualified targets.
      resourcePolicy: {
        policy: RESOURCE_POLICY.policy,
        enforced: RESOURCE_POLICY.enforced,
        hash: RESOURCE_POLICY_HASH,
      },
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
  execute(
    name: unknown,
    args: unknown,
    principal: Principal,
    requestId?: string,
  ) {
    return execute(
      { store: this.store, queue: this.queue, principal, requestId },
      name,
      args,
    );
  }
  async call(
    name: unknown,
    args: unknown,
    principal: Principal = principals["local-client"],
    requestId?: string,
  ) {
    return (await this.execute(name, args, principal, requestId)).result;
  }
}
