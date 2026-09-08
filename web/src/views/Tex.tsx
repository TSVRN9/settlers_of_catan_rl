// Text with LaTeX between $…$, the math rendered to MathML by KaTeX and drawn by the browser
// itself — no KaTeX CSS or fonts. KaTeX is loaded the first time a card asks for it, so the
// bundle the table needs stays as it was.
import { useEffect, useState } from "react";

type Katex = typeof import("katex");
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;
const load = () => (loading ??= import("katex").then((m) => (katex = m.default ? (m.default as unknown as Katex) : m)));

export default function Tex({ text }: { text: string }) {
  const [, ready] = useState(katex != null);
  useEffect(() => { if (!katex) void load().then(() => ready(true)); }, []);
  if (!text.includes("$")) return <>{text}</>;
  if (!katex) return null;
  const k = katex;
  return (
    <>
      {text.split(/\$([^$]+)\$/).map((part, i) => (i % 2 === 0
        ? part
        : <span key={i} dangerouslySetInnerHTML={{ __html: k.renderToString(part, { output: "mathml", throwOnError: false }) }} />
      ))}
    </>
  );
}
