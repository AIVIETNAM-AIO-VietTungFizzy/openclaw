import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { installPackageDir } from "../../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../../infra/install-safe-path.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type RcSkillInstallResult =
  | { ok: true; targetDir: string }
  | { ok: false; error: string };

async function downloadFromRc(downloadUrl: string, downloadToken: string): Promise<Buffer> {
  const url = new URL(downloadUrl);
  url.searchParams.set("token", downloadToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) throw new Error(`RC download failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return zlib.gunzipSync(buf);
  } finally {
    clearTimeout(timer);
  }
}

async function callbackRc(callbackUrl: string, callbackToken: string | undefined, body: Record<string, unknown>) {
  const url = new URL(callbackUrl);
  if (callbackToken) url.searchParams.set("token", callbackToken);
  try {
    await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // fire-and-forget; log if possible
  }
}

export async function installSkillFromRc(params: {
  config: OpenClawConfig;
  slug: string;
  agentId: string;
  downloadUrl: string;
  downloadToken: string;
  callbackUrl: string;
}): Promise<RcSkillInstallResult> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
    const skillsDir = path.join(path.resolve(workspaceDir), "skills");
    const target = resolveSafeInstallDir({ baseDir: skillsDir, id: params.slug, invalidNameMessage: "invalid skill target path" });
    if (!target.ok) return { ok: false, error: target.error };

    const raw = await downloadFromRc(params.downloadUrl, params.downloadToken);
    const pkg = JSON.parse(raw.toString("utf-8"));
    if (!pkg.files || typeof pkg.files !== "object") {
      return { ok: false, error: "Invalid skill package: missing files" };
    }

    const tmpDir = path.join(skillsDir, `.tmp-${params.slug}-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      for (const [filePath, content] of Object.entries(pkg.files)) {
        const fullPath = path.join(tmpDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content as string, "utf-8");
      }

      const exists = await pathExists(target.path);
      const install = await installPackageDir({
        sourceDir: tmpDir,
        targetDir: target.path,
        mode: exists ? "update" : "install",
        timeoutMs: 120_000,
        copyErrorPrefix: "failed to install skill from RC",
        hasDeps: false,
        depsLogMessage: "",
      });
      if (!install.ok) return { ok: false, error: install.error };

      await callbackRc(params.callbackUrl, params.downloadToken, {
        agentId: params.agentId,
        status: "installed",
        content_hash: pkg.content_hash || null,
      });

      return { ok: true, targetDir: target.path };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    const msg = formatErrorMessage(err);
    await callbackRc(params.callbackUrl, params.downloadToken, {
      agentId: params.agentId,
      status: "failed",
      error: msg,
    }).catch(() => {});
    return { ok: false, error: msg };
  }
}

export async function uninstallSkillFromRc(params: {
  config: OpenClawConfig;
  slug: string;
  callbackUrl: string;
  callbackToken: string;
}): Promise<RcSkillInstallResult> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
    const target = resolveSafeInstallDir({
      baseDir: path.join(path.resolve(workspaceDir), "skills"),
      id: params.slug,
      invalidNameMessage: "invalid skill target path",
    });
    if (!target.ok) return { ok: false, error: target.error };

    if (await pathExists(target.path)) {
      await fs.rm(target.path, { recursive: true, force: true });
    }

    await callbackRc(params.callbackUrl, params.callbackToken, {
      agentId: "openclaw",
      status: "uninstalled",
    });

    return { ok: true, targetDir: target.path };
  } catch (err) {
    const msg = formatErrorMessage(err);
    await callbackRc(params.callbackUrl, params.callbackToken, {
      agentId: "openclaw",
      status: "failed",
      error: msg,
    }).catch(() => {});
    return { ok: false, error: msg };
  }
}
