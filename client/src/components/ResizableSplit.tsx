import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../stores/useStore";

interface ResizableSplitProps {
  storageKey: string;
  direction: "row" | "col";
  children: ReactNode[];
  minPaneSize?: number;
}

const HANDLE_SIZE = 4;
const MIN_RATIO = 0.05;

function normalize(ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0) return ratios.map(() => 1 / ratios.length);
  return ratios.map((r) => r / sum);
}

export function ResizableSplit({
  storageKey,
  direction,
  children,
  minPaneSize = 80,
}: ResizableSplitProps) {
  const stored = useStore((s) => s.splitRatios[storageKey]);
  const setSplitRatios = useStore((s) => s.setSplitRatios);
  const containerRef = useRef<HTMLDivElement>(null);

  const childCount = children.length;
  const equal = Array.from({ length: childCount }, () => 1 / childCount);

  // Local ratios for smooth dragging; flush to store on drag end.
  const [ratios, setRatios] = useState<number[]>(() => {
    if (stored && stored.length === childCount) return normalize(stored);
    return equal;
  });

  // Keep in sync when child count changes.
  useEffect(() => {
    if (ratios.length !== childCount) {
      setRatios(equal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childCount]);

  const dragRef = useRef<{
    index: number;
    startCoord: number;
    totalSize: number;
    startRatios: number[];
  } | null>(null);

  const handleMouseDown = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const totalSize = direction === "row" ? rect.width : rect.height;
      dragRef.current = {
        index,
        startCoord: direction === "row" ? e.clientX : e.clientY,
        totalSize,
        startRatios: ratios.slice(),
      };

      const handleMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const coord = direction === "row" ? ev.clientX : ev.clientY;
        const delta = (coord - drag.startCoord) / drag.totalSize;
        const next = drag.startRatios.slice();
        const left = next[drag.index] + delta;
        const right = next[drag.index + 1] - delta;
        const minRatio = Math.max(MIN_RATIO, minPaneSize / drag.totalSize);
        if (left < minRatio || right < minRatio) return;
        next[drag.index] = left;
        next[drag.index + 1] = right;
        setRatios(next);
      };

      const handleUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (drag) {
          // Persist final ratios.
          setRatios((current) => {
            setSplitRatios(storageKey, current);
            return current;
          });
        }
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
      document.body.style.cursor = direction === "row" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction, ratios, minPaneSize, setSplitRatios, storageKey],
  );

  const isRow = direction === "row";

  return (
    <div
      ref={containerRef}
      className="flex w-full h-full min-h-0 min-w-0"
      style={{ flexDirection: isRow ? "row" : "column" }}
    >
      {children.map((child, i) => {
        const flex = ratios[i] ?? 1 / childCount;
        return (
          <Pane key={i} flex={flex} isRow={isRow} hasHandle={i < childCount - 1}>
            {child}
            {i < childCount - 1 && (
              <div
                onMouseDown={handleMouseDown(i)}
                className="flex-shrink-0 group"
                style={{
                  position: "absolute",
                  ...(isRow
                    ? {
                        right: -HANDLE_SIZE / 2,
                        top: 0,
                        bottom: 0,
                        width: HANDLE_SIZE,
                        cursor: "col-resize",
                      }
                    : {
                        bottom: -HANDLE_SIZE / 2,
                        left: 0,
                        right: 0,
                        height: HANDLE_SIZE,
                        cursor: "row-resize",
                      }),
                  zIndex: 20,
                }}
              >
                <div
                  className="w-full h-full transition-colors group-hover:bg-blue-500/40"
                  style={{ backgroundColor: "transparent" }}
                />
              </div>
            )}
          </Pane>
        );
      })}
    </div>
  );
}

function Pane({
  flex,
  isRow,
  hasHandle,
  children,
}: {
  flex: number;
  isRow: boolean;
  hasHandle: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="relative min-w-0 min-h-0 overflow-hidden"
      style={{
        flex: `${flex} ${flex} 0`,
        ...(isRow
          ? { borderRight: hasHandle ? "1px solid #2a2a2a" : undefined }
          : { borderBottom: hasHandle ? "1px solid #2a2a2a" : undefined }),
      }}
    >
      {children}
    </div>
  );
}
