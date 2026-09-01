import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Resolves resource URIs referenced from a URDF/Xacro document (mesh files,
 * textures) into absolute filesystem paths. Handles:
 *   - package://<pkg>/rest        via robotViewer.packages setting, workspace
 *                                 search, and model-directory fallbacks
 *   - file:///abs/path
 *   - absolute and relative paths (relative to the model file directory)
 *
 * The model directory and its parent are always treated as implicit package
 * roots, so models opened as a single file (without a matching ROS package
 * layout) still resolve their meshes.
 */
export class ResourceResolver {
  private readonly parentDir: string;

  constructor(private readonly modelDir: string) {
    this.parentDir = path.dirname(modelDir);
  }

  private get packages(): Record<string, string> {
    return vscode.workspace
      .getConfiguration("robotViewer")
      .get<Record<string, string>>("packages", {});
  }

  /** Extra search roots that act as implicit package containers. */
  private searchRoots(): string[] {
    const roots = [this.modelDir, this.parentDir];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      roots.push(f.uri.fsPath);
    }
    return [...new Set(roots)];
  }

  private expandVariables(value: string): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const first = folders[0]?.uri.fsPath ?? this.modelDir;
    let out = value.replace(/\$\{workspaceFolder\}/g, first);
    out = out.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_m, name) => {
      const f = folders.find((w) => w.name === name);
      return f ? f.uri.fsPath : first;
    });
    out = out.replace(/\$\{env:([^}]+)\}/g, (_m, name) => process.env[name] ?? "");
    return out;
  }

  /** All candidate absolute paths for a package://pkg/rest reference. */
  private packageCandidates(pkg: string, rest: string): string[] {
    const candidates: string[] = [];

    const mapped = this.packages[pkg];
    if (mapped) {
      let base = this.expandVariables(mapped);
      if (!path.isAbsolute(base)) {
        base = path.join(this.searchRoots()[0], base);
      }
      candidates.push(path.join(base, rest));
    }

    for (const root of this.searchRoots()) {
      // pkg is a subdirectory of the root (standard ROS package layout).
      candidates.push(path.join(root, pkg, rest));
      // pkg name does not match a folder: resolve rest relative to the root.
      candidates.push(path.join(root, rest));
    }

    // Deep search for a directory literally named <pkg>.
    for (const root of this.searchRoots()) {
      const found = this.findPackageDir(root, pkg);
      if (found) {
        candidates.push(path.join(found, rest));
      }
    }

    return [...new Set(candidates)];
  }

  private findPackageDir(root: string, pkg: string, depth = 4): string | undefined {
    try {
      const direct = path.join(root, pkg);
      if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
        return direct;
      }
      if (depth <= 0) {
        return undefined;
      }
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        const found = this.findPackageDir(path.join(root, entry.name), pkg, depth - 1);
        if (found) {
          return found;
        }
      }
    } catch {
      /* ignore unreadable directories */
    }
    return undefined;
  }

  private firstExisting(candidates: string[]): string | undefined {
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return candidates[0];
  }

  /** Returns an absolute filesystem path for a referenced URI, or undefined. */
  resolve(uri: string): string | undefined {
    let cleaned = uri.trim();
    if (cleaned.startsWith("file://")) {
      try {
        return vscode.Uri.parse(cleaned).fsPath;
      } catch {
        cleaned = cleaned.replace(/^file:\/\//, "");
      }
    }

    const pkgMatch = /^package:\/\/([^/]+)\/(.*)$/.exec(cleaned);
    if (pkgMatch) {
      return this.firstExisting(this.packageCandidates(pkgMatch[1], pkgMatch[2]));
    }

    if (path.isAbsolute(cleaned)) {
      return cleaned;
    }

    // Relative reference: try the model dir first, then its parent.
    return this.firstExisting([
      path.join(this.modelDir, cleaned),
      path.join(this.parentDir, cleaned),
    ]);
  }
}
