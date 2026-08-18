import { motion } from "framer-motion";
import { Plus, FolderPlus, Sparkles } from "./icons";
import { useReactFlow } from "@xyflow/react";
import { useStore } from "../stores/useStore";
import {
  buildTitleClusterCanvasLayout,
  fetchTitleClusterPlan,
  persistAgentPositions,
} from "../utils/canvasLayout";

const CATEGORY_COLORS = ["#D97652", "#22C55E", "#3B82F6", "#8B5CF6", "#EC4899", "#14B8A6"];

export function CanvasControls() {
  const { setAddAgentModalOpen, nodes, addNode, setNodes, sessions } = useStore();
  const reactFlow = useReactFlow();

  const handleAddAgent = () => {
    setAddAgentModalOpen(true);
  };

  const handleAddCategory = async () => {
    const id = `category-${Date.now()}`;
    const color = CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)];

    // Find a good position (offset from existing nodes)
    const categoryCount = nodes.filter(n => n.type === "category").length;
    const position = {
      x: 50 + (categoryCount % 3) * 300,
      y: 50 + Math.floor(categoryCount / 3) * 250,
    };

    const category = {
      id,
      label: "New Category",
      color,
      position,
      width: 250,
      height: 200,
    };

    // Save to server
    await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(category),
    });

    // Add to canvas
    addNode({
      id,
      type: "category",
      position,
      style: { width: 250, height: 200 },
      data: {
        label: "New Category",
        color,
      },
      zIndex: -1,
    });
  };

  const handleCleanCanvas = async () => {
    const plan = await fetchTitleClusterPlan(nodes, sessions).catch(() => null);
    const nextNodes = buildTitleClusterCanvasLayout(nodes, sessions, plan);
    setNodes(nextNodes);
    // Frame the tidied grid after React Flow applies the new positions.
    requestAnimationFrame(() =>
      reactFlow.fitView({ padding: 0.2, duration: 400 }),
    );
    await persistAgentPositions(nextNodes).catch(console.error);
  };

  const buttonClass =
    "h-9 w-9 rounded-md border border-border bg-canvas-dark shadow-lg flex items-center justify-center text-zinc-500 transition-colors hover:bg-surface-hover hover:text-zinc-100";

  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-row items-center gap-1.5">
      <motion.button
        onClick={handleCleanCanvas}
        className={buttonClass}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title="Auto sort by title blast radius"
      >
        <Sparkles className="w-4 h-4" />
      </motion.button>
      <motion.button
        onClick={handleAddCategory}
        className={buttonClass}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title="New Category"
      >
        <FolderPlus className="w-4 h-4" />
      </motion.button>
      <motion.button
        onClick={handleAddAgent}
        className="h-9 w-9 rounded-md bg-zinc-100 shadow-lg flex items-center justify-center text-canvas transition-colors hover:bg-white"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title="New Agent"
      >
        <Plus className="w-4 h-4" />
      </motion.button>
    </div>
  );
}
