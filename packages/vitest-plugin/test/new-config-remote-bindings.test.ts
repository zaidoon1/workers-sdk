import fs from "node:fs/promises";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { beforeEach, describe, it, vi } from "vitest";
import type { RemoteProxyConnectionString } from "miniflare";
import type { TestProject } from "vitest/node";

const remoteProxyConnectionString = new URL(
	"http://localhost:8787"
) as RemoteProxyConnectionString;

const {
	maybeStartOrUpdateRemoteProxySession,
	requireAuth,
	resolveProfile,
	state,
} = vi.hoisted(() => ({
	maybeStartOrUpdateRemoteProxySession: vi.fn(),
	requireAuth: vi.fn(async () => "cf-account-id"),
	resolveProfile: vi.fn(() => ({ name: "cf-profile" })),
	state: { wranglerImported: false },
}));

vi.mock("@cloudflare/remote-bindings", () => ({
	maybeStartOrUpdateRemoteProxySession,
}));

vi.mock("@cloudflare/workers-auth/cf", () => ({
	createCfAuth: () => ({
		setProfile: vi.fn(),
		requireAuth,
		requireApiToken: () => ({ apiToken: "cf-token" }),
	}),
	createCfProfileStore: () => ({ resolve: resolveProfile }),
}));

// Records whether Wrangler was imported, and stands in for it. Modules are
// reset before each test, so this factory runs again on each first import.
vi.mock("wrangler", () => {
	state.wranglerImported = true;
	return {
		unstable_readConfig: () => ({
			name: "test-worker",
			topLevelName: "test-worker",
		}),
		unstable_convertConfigBindingsToStartWorkerBindings: () => ({
			KV: { type: "kv_namespace", id: "kv-id", remote: true },
		}),
		unstable_getMiniflareWorkerOptions: () => ({
			workerOptions: {},
			externalWorkers: [],
			define: {},
			main: undefined,
		}),
	};
});

describe("remote bindings", () => {
	runInTempDir();

	let project: TestProject;

	beforeEach(() => {
		vi.resetModules();
		state.wranglerImported = false;
		project = {
			config: { root: process.cwd() },
			vite: { config: { mode: "test", envDir: process.cwd() } },
		} as unknown as TestProject;
		maybeStartOrUpdateRemoteProxySession.mockReset();
		maybeStartOrUpdateRemoteProxySession.mockResolvedValue({
			session: { remoteProxyConnectionString },
			remoteBindings: {},
		});
	});

	it("uses cf credentials for cloudflare.config.ts, without Wrangler", async ({
		expect,
	}) => {
		await fs.writeFile(
			"cloudflare.config.ts",
			`export default {
				accountId: "account-id",
				worker: {
					name: "test-worker",
					compatibilityDate: "2025-12-02",
					env: {
						KV: { type: "kv", id: "kv-id", dev: { remote: true } },
					},
				},
			};`
		);
		const { parseProjectOptions } = await import("../src/pool/config");

		const options = await parseProjectOptions(project, {
			experimental: { newConfig: true },
		});
		await parseProjectOptions(project, { experimental: { newConfig: true } });

		const [[details, , auth, context], [, , secondAuth]] =
			maybeStartOrUpdateRemoteProxySession.mock.calls;
		expect(details).toMatchObject({
			name: "test-worker",
			bindings: {
				KV: { type: "kv_namespace", id: "kv-id", remote: true },
			},
		});
		expect(context).toMatchObject({ cliDisplayName: "cf" });
		// The same hook, so the session isn't restarted on every re-parse
		expect(secondAuth).toBe(auth);
		await expect(auth()).resolves.toEqual({
			accountId: "cf-account-id",
			apiToken: { apiToken: "cf-token" },
		});
		expect(requireAuth).toHaveBeenCalledWith({ account_id: "account-id" });
		expect(resolveProfile).toHaveBeenCalledWith({ cwd: process.cwd() });
		expect(options.remoteProxyConnectionString).toBe(
			remoteProxyConnectionString
		);
		expect(state.wranglerImported).toBe(false);
	});

	it("keeps Wrangler's credentials for Wrangler configs", async ({
		expect,
	}) => {
		const { parseProjectOptions } = await import("../src/pool/config");

		await parseProjectOptions(project, {
			wrangler: { configPath: "./wrangler.jsonc" },
		});

		const [[, , auth, context]] =
			maybeStartOrUpdateRemoteProxySession.mock.calls;
		expect(auth).toBeUndefined();
		expect(context).toMatchObject({ cliDisplayName: "Wrangler" });
		expect(state.wranglerImported).toBe(true);
	});
});
