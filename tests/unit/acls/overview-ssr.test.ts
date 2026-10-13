import { PassThrough } from "node:stream";

import { createElement } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("~/routes/acls/acl-loader", () => ({ aclLoader: vi.fn() }));
vi.mock("~/routes/acls/acl-action", () => ({ aclAction: vi.fn() }));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));

// React Router removes browser-only exports from the actual server bundle.
// Model that build boundary, rather than a working CodeMirror server component.
vi.mock("~/routes/acls/components/cm.client", () => ({
  Editor: undefined,
  Differ: undefined,
}));

import Page from "~/routes/acls/overview";

async function renderDocument(access: boolean, writable: boolean) {
  return new Promise<{ html: string; status: number; errors: unknown[] }>((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    let status = 200;
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("error", reject);
    output.on("end", () => resolve({ html: Buffer.concat(chunks).toString(), status, errors }));
    const stream = renderToPipeableStream(
      createElement(Page, { loaderData: { access, writable, policy: '{"acls":[]}' } } as any),
      {
        onAllReady: () => stream.pipe(output),
        onShellError: reject,
        onError: (error) => {
          errors.push(error);
          status = 500;
        },
      },
    );
  });
}

describe("ACL document server rendering", () => {
  test.for([
    [true, true, "editable"],
    [true, false, "read-only"],
    [false, false, "restricted"],
  ] as const)("returns a healthy document for %s/%s (%s)", async ([access, writable]) => {
    const result = await renderDocument(access, writable);
    expect(result.errors).toEqual([]);
    expect(result.status).toBe(200);
    expect(result.html).toContain("Access Control List (ACL)");
    expect(result.html).toContain("Loading editor");
    expect(result.html).not.toContain("Switched to client rendering");
  });
});
