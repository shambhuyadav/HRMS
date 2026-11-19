// The CV search screen (FR-013): matches within the candidate scope, never showing the approved CV text.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { DocumentTable } from './candidate-documents';
import { DOWNLOAD_WORDS, LoadProblem, Refusal } from './refusals';
import { Denied, DOCUMENT_READ, enc, LIMITS, useKeys } from './shared';
import type { CandidateDocument } from './types';

// ---------------------------------------------------------------------------------------------------------
// FR-013 CV search: file name, document type, candidate code and approved searchable CV text within the candidate
// scope; a match in the approved text is marked, and the text itself is never returned (I-82 item 4)
// ---------------------------------------------------------------------------------------------------------

export function CvSearchScreen() {
  const { can } = useSession();
  if (!can(DOCUMENT_READ)) return <Denied title="CV search">CVs are confidential: the selected role holds no candidate document grant.</Denied>;
  return (
    <>
      <h1>CV search</h1>
      <CvSearch />
    </>
  );
}

function CvSearch() {
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const hits = useQuery({
    queryKey: keys.cvSearch(term ?? ''),
    enabled: term !== null,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidate-documents?search=${enc(term ?? '')}`),
    retry: retryTransient,
  });
  const open = useMutation({ mutationFn: (d: CandidateDocument) => download(`/v1/hiring/candidate-documents/${enc(d.id)}/content`) });
  const items = hits.data?.items ?? [];
  return (
    <Section title="Search CVs">
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const text = search.trim();
          setProblem(text ? null : 'Enter a file name, document type, candidate code or words from a CV.');
          if (text) setTerm(text);
        }}
      >
        <label className="inline">
          File name, document type, candidate code or CV text
          <input type="search" required maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search
        </button>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <p className="hint">
        The search covers the file name, the document type, the candidate code and the approved searchable text of CVs. Only text an eligible Admin approved for a
        candidate whose consent is given is searched; a match in it is marked, and the text itself is never shown here. Files can be opened once the malware scan
        releases them; each opening is recorded in the audit trail.
      </p>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search candidate documents." />
      {hits.data && items.length === 0 && <Empty>{`No documents match “${term ?? ''}”.`}</Empty>}
      {items.length > 0 && <DocumentTable items={items} showCandidate showMatch busy={open.isPending} onOpen={(d) => open.mutate(d)} label="Matching documents" />}
      {items.length >= LIMITS.cvSearch && <p className="hint">Showing the latest {LIMITS.cvSearch} matches; refine the search.</p>}
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </Section>
  );
}

