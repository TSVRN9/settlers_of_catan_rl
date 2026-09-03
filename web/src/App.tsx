import * as tabs from "@zag-js/tabs";
import { normalizeProps, useMachine } from "@zag-js/react";
import { useEffect, useId, useState } from "react";
import Play from "./pages/Play";
import Watch from "./pages/Watch";
import Results from "./pages/Results";
import About from "./pages/About";

const ROUTES = [
  { value: "play", label: "Play" },
  { value: "watch", label: "Watch" },
  { value: "results", label: "Results" },
  { value: "about", label: "About" },
];
const route = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "play");

export default function App() {
  const [current, setCurrent] = useState(route);
  useEffect(() => {
    const on = () => setCurrent(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const service = useMachine(tabs.machine, { id: useId(), value: current, onValueChange: ({ value }) => { location.hash = `#/${value}`; } });
  const api = tabs.connect(service, normalizeProps);
  return (
    <div {...api.getRootProps()} className="mx-auto max-w-7xl px-3 py-3 md:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">🏝️ Catan RL <span className="ml-1 text-sm font-normal text-stone-500">play the bots, watch them think</span></h1>
        <nav {...api.getListProps()} className="ml-auto flex gap-1">
          {ROUTES.map((r) => <button key={r.value} {...api.getTriggerProps({ value: r.value })} className="rounded-md border border-transparent px-3 py-1.5 text-sm font-medium hover:bg-stone-200 dark:hover:bg-stone-800">{r.label}</button>)}
        </nav>
      </header>
      <main>
        {current === "play" && <div {...api.getContentProps({ value: "play" })}><Play /></div>}
        {current === "watch" && <div {...api.getContentProps({ value: "watch" })}><Watch /></div>}
        {current === "results" && <div {...api.getContentProps({ value: "results" })}><Results /></div>}
        {current === "about" && <div {...api.getContentProps({ value: "about" })}><About /></div>}
      </main>
      <footer className="mt-8 text-xs text-stone-500">Engine and bots run locally in a Web Worker; nothing is sent anywhere. <a className="underline" href="https://github.com/TSVRN9/settlers_of_catan_rl">GitHub</a></footer>
    </div>
  );
}
