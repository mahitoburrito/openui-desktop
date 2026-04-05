import { useEffect } from "react";
import { usePRBEStore } from "../stores/usePRBEStore";

/**
 * Sets up IPC listeners for PRBE state updates from the Electron main process.
 * Call once in the root App component.
 */
export function usePRBEIPC() {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;

    // Check initial availability
    usePRBEStore.getState().checkAvailability();

    // Listen for state updates
    const onStateUpdate = (state: any) => {
      usePRBEStore.getState()._onStateUpdate(state);
    };

    const onInteractionRequest = (payload: any) => {
      usePRBEStore.getState()._onInteractionRequest(payload);
    };

    const onComplete = (data: any) => {
      usePRBEStore.getState()._onComplete(data);
    };

    const onError = (data: any) => {
      usePRBEStore.getState()._onError(data);
    };

    api.on("prbe:state-update", onStateUpdate);
    api.on("prbe:interaction-request", onInteractionRequest);
    api.on("prbe:complete", onComplete);
    api.on("prbe:error", onError);

    return () => {
      api.removeAllListeners("prbe:state-update");
      api.removeAllListeners("prbe:interaction-request");
      api.removeAllListeners("prbe:complete");
      api.removeAllListeners("prbe:error");
    };
  }, []);
}
