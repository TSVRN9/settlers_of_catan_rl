import * as dialog from "@zag-js/dialog";
import { Portal, normalizeProps, useMachine } from "@zag-js/react";
import { useId, type ReactNode } from "react";

export default function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const service = useMachine(dialog.machine, { id: useId(), open, onOpenChange: ({ open }) => { if (!open) onClose(); } });
  const api = dialog.connect(service, normalizeProps);
  if (!api.open) return null;
  return (
    <Portal>
      <div {...api.getBackdropProps()} className="fixed inset-0 z-40 bg-black/50" />
      <div {...api.getPositionerProps()} className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div {...api.getContentProps()} className="card w-full max-w-md max-h-[80vh] overflow-y-auto">
          <div className="mb-2 flex items-center justify-between">
            <h2 {...api.getTitleProps()} className="text-base font-semibold">{title}</h2>
            <button {...api.getCloseTriggerProps()} className="btn px-2 py-1" aria-label="Close">✕</button>
          </div>
          {children}
        </div>
      </div>
    </Portal>
  );
}
