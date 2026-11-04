import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

import {
  authContext,
  headscaleConfigContext,
  headscaleContext,
  integrationContext,
} from "~/server/context";
import { loadHeadscaleConfig } from "~/server/headscale/config-loader";

vi.mock("~/utils/log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// File permission checks are meaningless as root (root can write a 0444 file).
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

function request(fields: Record<string, string>): Request {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return { formData: () => Promise.resolve(formData) } as unknown as Request;
}

function context(headscaleConfig: Awaited<ReturnType<typeof loadHeadscaleConfig>>) {
  return {
    get: (key: unknown) => {
      if (key === authContext) return { require: () => Promise.resolve({}), can: () => true };
      if (key === headscaleConfigContext) return headscaleConfig;
      if (key === headscaleContext) return {};
      if (key === integrationContext) return undefined;
      return undefined;
    },
  };
}

async function runAction(
  headscaleConfig: Awaited<ReturnType<typeof loadHeadscaleConfig>>,
  fields: Record<string, string>,
) {
  const { dnsAction } = await import("~/routes/dns/dns-actions");
  return (await dnsAction({
    request: request(fields),
    context: context(headscaleConfig),
    params: {},
  } as any)) as { data?: unknown; init?: { status?: number } | null } | undefined;
}

describe.skipIf(asRoot)("DNS records with a read-only Headscale config", () => {
  let dir: string;
  let configPath: string;
  let recordsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "headplane-dns-ro-"));
    configPath = join(dir, "config.yaml");
    recordsPath = join(dir, "extra-records.json");
  });

  afterEach(async () => {
    await chmod(configPath, 0o644).catch(() => undefined);
    await chmod(recordsPath, 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(withRecordsFile: boolean) {
    const lines = ["server_url: http://localhost:8080", "dns:", "  base_domain: example.internal"];
    if (withRecordsFile) {
      lines.push(`  extra_records_path: ${recordsPath}`);
      await writeFile(
        recordsPath,
        JSON.stringify([{ name: "a.example.internal", type: "A", value: "10.0.0.1" }]),
      );
    } else {
      lines.push(
        "  extra_records:",
        "    - name: a.example.internal",
        "      type: A",
        "      value: 10.0.0.1",
      );
    }
    await writeFile(configPath, lines.join("\n"));
    await chmod(configPath, 0o444);
  }

  test("records in a separate writable file stay writable", async () => {
    await writeConfig(true);
    const config = await loadHeadscaleConfig(configPath);

    expect(config.writable()).toBe(false);
    expect(config.dnsRecordsWritable()).toBe(true);
  });

  test("add_record and remove_record write the records file and leave the config untouched", async () => {
    await writeConfig(true);
    const before = await readFile(configPath, "utf8");
    const config = await loadHeadscaleConfig(configPath);

    const added = await runAction(config, {
      action_id: "add_record",
      record_name: "b.example.internal",
      record_type: "A",
      record_value: "10.0.0.2",
    });
    expect(added?.init?.status ?? 200).toBe(200);
    expect(JSON.parse(await readFile(recordsPath, "utf8"))).toEqual([
      { name: "a.example.internal", type: "A", value: "10.0.0.1" },
      { name: "b.example.internal", type: "A", value: "10.0.0.2" },
    ]);

    const removed = await runAction(config, {
      action_id: "remove_record",
      record_name: "a.example.internal",
      record_type: "A",
    });
    expect(removed?.init?.status ?? 200).toBe(200);
    expect(JSON.parse(await readFile(recordsPath, "utf8"))).toEqual([
      { name: "b.example.internal", type: "A", value: "10.0.0.2" },
    ]);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  test("other DNS settings are still refused while the config is read-only", async () => {
    await writeConfig(true);
    const config = await loadHeadscaleConfig(configPath);

    const result = await runAction(config, {
      action_id: "rename_tailnet",
      new_name: "other.internal",
    });
    expect(result?.init?.status).toBe(403);
    expect(parse(await readFile(configPath, "utf8")).dns.base_domain).toBe("example.internal");
  });

  test("inline records follow the read-only config", async () => {
    await writeConfig(false);
    const config = await loadHeadscaleConfig(configPath);

    expect(config.dnsRecordsWritable()).toBe(false);
    const result = await runAction(config, {
      action_id: "add_record",
      record_name: "b.example.internal",
      record_type: "A",
      record_value: "10.0.0.2",
    });
    expect(result?.init?.status).toBe(403);
  });

  test("a read-only records file is not writable either", async () => {
    await writeConfig(true);
    await chmod(recordsPath, 0o444);
    const config = await loadHeadscaleConfig(configPath);

    expect(config.dnsRecordsWritable()).toBe(false);
    const result = await runAction(config, {
      action_id: "add_record",
      record_name: "b.example.internal",
      record_type: "A",
      record_value: "10.0.0.2",
    });
    expect(result?.init?.status).toBe(403);
  });
});
