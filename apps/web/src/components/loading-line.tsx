// What a screen says while it reads a list or a record ("Loading…"; the old `p.hint.loading`): one quiet muted line, not a note, and
// with no role, as before (the behaviour snapshot records every status text, and a loading line was never one).
import type { ReactNode } from 'react';

export function LoadingLine({ children }: { children: ReactNode }) {
  return <p className="py-1 text-[0.84rem] text-muted-foreground">{children}</p>;
}
