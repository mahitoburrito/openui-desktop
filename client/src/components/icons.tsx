import type { ComponentType, CSSProperties } from "react";
import { Codicon } from "./Codicon";

interface AppIconProps {
  className?: string;
  style?: CSSProperties;
  size?: number | string;
  color?: string;
  strokeWidth?: number;
}

export type LucideIcon = ComponentType<AppIconProps>;

function makeIcon(name: string): LucideIcon {
  const Icon = ({ className, style, size, color }: AppIconProps) => (
    <Codicon
      name={name}
      size={typeof size === "number" ? size : undefined}
      className={className}
      style={{ color, ...style }}
    />
  );
  Icon.displayName = `Codicon(${name})`;
  return Icon;
}

// One Cursor-style icon vocabulary for every piece of application chrome.
export const X = makeIcon("close");
export const Key = makeIcon("key");
export const Check = makeIcon("check");
export const AlertCircle = makeIcon("warning");
export const Loader2 = makeIcon("loading");
export const ExternalLink = makeIcon("link-external");
export const Bug = makeIcon("bug");
export const SlidersHorizontal = makeIcon("settings");
export const Puzzle = makeIcon("extensions");
export const Palette = makeIcon("symbol-color");
export const Type = makeIcon("symbol-string");
export const Monitor = makeIcon("device-desktop");
export const Minus = makeIcon("remove");
export const Plus = makeIcon("add");
export const Bell = makeIcon("bell");
export const FileText = makeIcon("file-text");
export const Sparkles = makeIcon("sparkle");
export const RefreshCw = makeIcon("refresh");
export const Code = makeIcon("code");
export const Eye = makeIcon("eye");
export const Copy = makeIcon("copy");
export const ArrowLeft = makeIcon("arrow-left");
export const Terminal = makeIcon("terminal");
export const Clock = makeIcon("clock");
export const Folder = makeIcon("folder");
export const Edit3 = makeIcon("edit");
export const RotateCcw = makeIcon("discard");
export const Cpu = makeIcon("server-process");
export const Zap = makeIcon("zap");
export const Rocket = makeIcon("rocket");
export const Bot = makeIcon("hubot");
export const Brain = makeIcon("lightbulb");
export const Wand2 = makeIcon("wand");
export const GitBranch = makeIcon("git-branch");
export const Paperclip = makeIcon("attach");
export const Undo2 = makeIcon("discard");
export const Trash2 = makeIcon("trash");
export const FolderOpen = makeIcon("folder-opened");
export const FolderPlus = makeIcon("new-folder");
export const Search = makeIcon("search");
export const Home = makeIcon("home");
export const ArrowUp = makeIcon("arrow-up");
export const Github = makeIcon("github");
export const Ticket = makeIcon("issues");
export const MessageSquare = makeIcon("comment-discussion");
export const Shield = makeIcon("shield");
export const Send = makeIcon("send");
export const Minimize2 = makeIcon("screen-normal");
export const Columns = makeIcon("split-horizontal");
export const Rows = makeIcon("split-vertical");
export const Grid2X2 = makeIcon("layout");
export const Square = makeIcon("window");
export const FolderGit2 = makeIcon("repo");
export const FileDiff = makeIcon("diff");
export const ChevronDown = makeIcon("chevron-down");
export const ChevronRight = makeIcon("chevron-right");
export const Columns2 = makeIcon("split-horizontal");
export const Rows3 = makeIcon("split-vertical");
export const WrapText = makeIcon("word-wrap");
export const History = makeIcon("history");
export const Save = makeIcon("save");
export const Clipboard = makeIcon("clippy");
export const Wrench = makeIcon("tools");
export const CheckCircle2 = makeIcon("pass");
