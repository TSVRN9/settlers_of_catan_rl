import * as menu from "@zag-js/menu";
import { Portal, normalizeProps, useMachine } from "@zag-js/react";
import { useId, type ReactNode } from "react";

export default function Menu({ trigger, items, onSelect }: { trigger: ReactNode; items: { value: string; label: string }[]; onSelect: (v: string) => void }) {
  const service = useMachine(menu.machine, { id: useId(), onSelect: ({ value }) => onSelect(value) });
  const api = menu.connect(service, normalizeProps);
  return (
    <>
      <button {...api.getTriggerProps()} className="btn">{trigger} ▾</button>
      <Portal>
        <div {...api.getPositionerProps()} className="z-50">
          <ul {...api.getContentProps()} className="card min-w-40 p-1 outline-none">
            {items.map((it) => (
              <li key={it.value} {...api.getItemProps({ value: it.value })} className="cursor-pointer rounded px-2 py-1 text-sm data-highlighted:bg-amber-100 dark:data-highlighted:bg-amber-900/40">{it.label}</li>
            ))}
          </ul>
        </div>
      </Portal>
    </>
  );
}
