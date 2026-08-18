import { useState } from "react";
import { ChevronDown, ChevronRight } from "../icons";
import type { ChangedFile, TreeNode } from "./diffModel";

function StatusBadge({ status, untracked }: { status: string; untracked: boolean }) {
  const letter = untracked ? "A" : status.replace("?", "M").charAt(0) || "M";
  const color =
    letter === "A"
      ? "text-green-500 bg-green-500/10"
      : letter === "D"
        ? "text-red-400 bg-red-500/10"
        : letter === "R"
          ? "text-blue-400 bg-blue-500/10"
          : "text-amber-400 bg-amber-500/10";
  return (
    <span
      className={`flex-shrink-0 w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center ${color}`}
      title={untracked ? "Added (untracked)" : status}
    >
      {letter}
    </span>
  );
}

function FileRow({
  file,
  depth,
  active,
  onSelect,
}: {
  file: ChangedFile;
  depth: number;
  active: boolean;
  onSelect: (path: string) => void;
}) {
  const name = file.path.split("/").pop() || file.path;
  return (
    <div
      data-path={file.path}
      onClick={() => onSelect(file.path)}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`pr-2.5 py-1 flex items-center gap-2 cursor-pointer border-l-2 transition-colors ${
        active
          ? "bg-surface-active border-blue-500"
          : "border-transparent hover:bg-surface-active/50"
      }`}
    >
      <StatusBadge status={file.status} untracked={file.untracked} />
      <span className="text-[12px] text-white truncate flex-1" title={file.path}>
        {name}
      </span>
      <span className="flex-shrink-0 text-[9px] font-mono">
        {file.added > 0 && <span className="text-green-500">+{file.added}</span>}
        {file.removed > 0 && <span className="text-red-400 ml-1">−{file.removed}</span>}
      </span>
    </div>
  );
}

function DirRow({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: Extract<TreeNode, { type: "dir" }>;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="pr-2.5 py-1 flex items-center gap-1 cursor-pointer text-zinc-400 hover:bg-surface-active/40 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-600" />
        )}
        <span className="text-[11px] font-mono truncate" title={node.path}>
          {node.name}
        </span>
      </div>
      {open &&
        node.children.map((child) =>
          child.type === "dir" ? (
            <DirRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
            />
          ) : (
            <FileRow
              key={child.file.path}
              file={child.file}
              depth={depth + 1}
              active={child.file.path === activePath}
              onSelect={onSelect}
            />
          ),
        )}
    </>
  );
}

export function FileTree({
  tree,
  activePath,
  onSelect,
}: {
  tree: TreeNode[];
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {tree.map((node) =>
        node.type === "dir" ? (
          <DirRow
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            onSelect={onSelect}
          />
        ) : (
          <FileRow
            key={node.file.path}
            file={node.file}
            depth={0}
            active={node.file.path === activePath}
            onSelect={onSelect}
          />
        ),
      )}
    </>
  );
}
