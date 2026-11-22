// Policy upload: publish a policy or a new version, or change its title and classification.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, fileToBase64, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Notice, Section } from '../../ui';
import { CHANGE_WORDS, PUBLISH_WORDS, Refusal, VERSION_WORDS } from './refusals';
import {
  type Classification,
  FILE_ACCEPT,
  PATHS,
  POLICY_CODE,
  POLICY_MANAGE,
  POLICY_MANAGE_CONFIDENTIAL,
  POLICY_READ,
  type PolicyDetail,
  type PolicyItem,
  type Published,
  useKeys,
  UUID,
} from './shared';
import { ClassificationBadge, Expiry, PolicyFacts, PolicyUnavailable, scanOutcome, usePolicy, VersionHistory } from './shared-views';

// ---------------------------------------------------------------------------------------------------------
// Policy upload: publish a policy, a new version, or change its title and classification
// ---------------------------------------------------------------------------------------------------------
export function ManagePoliciesScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const canManage = can(POLICY_MANAGE);
  const canRead = can(POLICY_READ);
  const list = useQuery({ queryKey: keys.policies, enabled: canManage && canRead, queryFn: () => api<{ items: PolicyItem[] }>('/v1/company-policies'), retry: retryTransient });

  if (!canManage) {
    return (
      <Section title="Policy upload">
        <NotPermitted>The selected role cannot publish company policies.</NotPermitted>
      </Section>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <>
      <PublishPolicyForm />
      <Section title="Published policies">
        {!canRead && <NotPermitted>The selected role cannot list company policies.</NotPermitted>}
        {canRead && list.isPending && <LoadingLine>Loading policies…</LoadingLine>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot list company policies.</NotPermitted> : <ErrorNote error={list.error} />}
        {list.data && items.length === 0 && <Empty>No company policies are published yet.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Published policies">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Policy</TableHead>
                <TableHead scope="col">Classification</TableHead>
                <TableHead scope="col">Released version</TableHead>
                <TableHead scope="col">Expires</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Manage</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => {
                const released = p.currentVersion?.versionNumber ?? 0;
                const latest = p.latestVersionNumber ?? 0;
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      {p.title} <Hint as="span">{p.policyCode}</Hint>
                    </TableCell>
                    <TableCell>
                      <ClassificationBadge classification={p.classification} />
                    </TableCell>
                    <TableCell>
                      {p.currentVersion ? `Version ${p.currentVersion.versionNumber}` : 'None released yet'}
                      {latest > released && <HintLine>Version {latest} is not released (waiting for the malware scan, or quarantined).</HintLine>}
                    </TableCell>
                    <TableCell>{p.currentVersion ? <Expiry expiresOn={p.currentVersion.expiresOn} expired={p.currentVersion.expired} /> : '—'}</TableCell>
                    <TableCell>
                      <Link to={PATHS.managePolicy(p.id)} aria-label={`Manage ${p.title}`}>
                        Manage
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}

function PublishPolicyForm() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canConfidential = can(POLICY_MANAGE_CONFIDENTIAL);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [classification, setClassification] = useState<Classification>('OPERATIONAL');
  const [expiresOn, setExpiresOn] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Remounting the form after a publication clears the chosen file as well as the typed fields.
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<{ id: string; label: string; scanState: string | null } | null>(null);
  const publish = useMutation({
    mutationFn: async (f: File) =>
      api<Published>('/v1/company-policies', {
        body: {
          policyCode: code,
          title: title.trim(),
          classification,
          fileName: f.name,
          contentBase64: await fileToBase64(f),
          ...(expiresOn ? { expiresOn } : {}),
          ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        },
      }),
    onMutate: () => setDone(null),
    onSuccess: (result) => {
      setDone({ id: result.id, label: `${title.trim()} (${code})`, scanState: result.scanState });
      setCode('');
      setTitle('');
      setClassification('OPERATIONAL');
      setExpiresOn('');
      setChangeNote('');
      setFile(null);
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  const codeOk = POLICY_CODE.test(code);
  const ready = codeOk && title.trim() !== '' && file !== null && !publish.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && file) publish.mutate(file);
  };

  return (
    <Section title="Publish a new policy">
      <FormGrid key={formKey} aria-label="Publish a new policy" onSubmit={submit}>
        <FormField>
          Policy code
          <Input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </FormField>
        <FormField>
          Title
          <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField>
          Classification
          <NativeSelect value={classification} onChange={(e) => setClassification(e.target.value as Classification)}>
            <option value="OPERATIONAL">Operational (every employee of the company)</option>
            {canConfidential && <option value="CONFIDENTIAL">Confidential (confidential policy grant only)</option>}
          </NativeSelect>
        </FormField>
        <FormField>
          Expires on (optional)
          <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Change note (optional)
          <Input maxLength={1000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Policy file
          <Input type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
        <div className="col-span-full">
          <Button type="submit" disabled={!ready}>
            Publish
          </Button>
        </div>
      </FormGrid>
      {code !== '' && !codeOk && <Hint>A policy code starts with an upper-case letter, followed by up to 39 upper-case letters, digits or _.</Hint>}
      <Hint>PDF, JPEG or PNG up to 10 MB. The code is permanent; later changes are new versions. Every file is scanned for malware before anyone can open it.</Hint>
      {done && (
        <StatusNote tone="success" role="status">
          Published {done.label}, version 1. {scanOutcome(done.scanState)} <Link to={PATHS.managePolicy(done.id)}>Manage this policy</Link>
        </StatusNote>
      )}
      <Refusal error={publish.error} words={PUBLISH_WORDS} />
    </Section>
  );
}

export function ManagePolicyScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canManage = can(POLICY_MANAGE);
  const canRead = can(POLICY_READ);
  const detail = usePolicy(id, canManage && canRead);
  return (
    <>
      <BackLink to={PATHS.manage}>← Policy upload</BackLink>
      <ManagePolicyBody id={id} allowed={canManage && canRead} error={detail.error} policy={detail.data} />
    </>
  );
}

/** The policy's cards: refused, unavailable, loading, or its versions and the forms that change it. */
function ManagePolicyBody({ id, allowed, error, policy: p }: { id: string; allowed: boolean; error: unknown; policy: PolicyDetail | undefined }) {
  if (!allowed) {
    return (
      <Section title="Manage company policy">
        <NotPermitted>The selected role cannot manage company policies.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id) || error) {
    return (
      <Section title="Manage company policy">
        <PolicyUnavailable error={error ?? new ApiError(404, 'NOT_FOUND', 'Not found')} />
      </Section>
    );
  }
  if (!p) return <LoadingLine>Loading the policy…</LoadingLine>;
  return (
    <>
      <Section title={`${p.title} (${p.policyCode})`}>
        <PolicyFacts policy={p} />
        <h3>Versions</h3>
        <Hint>Versions are kept as published: an expiry date belongs to its version and does not change. To change it, publish a new version.</Hint>
        <VersionHistory versions={p.versions} />
      </Section>
      <NewVersionForm policy={p} />
      <PolicyChangeForm policy={p} />
    </>
  );
}

function NewVersionForm({ policy }: { policy: PolicyDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [expiresOn, setExpiresOn] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<{ versionNumber: number; scanState: string | null } | null>(null);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policy(policy.id) });
    void qc.invalidateQueries({ queryKey: keys.policies });
  };
  const publish = useMutation({
    mutationFn: async (f: File) =>
      api<Published>(`/v1/company-policies/${encodeURIComponent(policy.id)}/versions`, {
        body: {
          fileName: f.name,
          contentBase64: await fileToBase64(f),
          expectedVersion: policy.version,
          ...(expiresOn ? { expiresOn } : {}),
          ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        },
      }),
    onMutate: () => setDone(null),
    onSuccess: (result) => {
      setDone({ versionNumber: result.versionNumber, scanState: result.scanState });
      setExpiresOn('');
      setChangeNote('');
      setFile(null);
      setFormKey((k) => k + 1);
      reload();
    },
    onError: (error) => {
      // Someone else changed the policy: show it as it is now; what was typed stays for the retry.
      if (error instanceof ApiError && error.code === 'STALE_VERSION') reload();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !publish.isPending) publish.mutate(file);
  };
  return (
    <Section title="Publish a new version">
      <FormGrid key={formKey} aria-label="Publish a new version" onSubmit={submit}>
        <FormField>
          Expires on (optional)
          <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Change note (optional)
          <Input maxLength={1000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Version file
          <Input type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
        <div className="col-span-full">
          <Button type="submit" disabled={!file || publish.isPending}>
            Publish version
          </Button>
        </div>
      </FormGrid>
      <Hint>The new version becomes the current one once the malware scan releases it; earlier versions stay on record.</Hint>
      {done && <Notice notice={{ text: `Published version ${done.versionNumber}. ${scanOutcome(done.scanState)}`, ok: true }} />}
      <Refusal error={publish.error} words={VERSION_WORDS} />
    </Section>
  );
}

/** What saving the chosen classification would change, said before it is sent; null while it is unchanged. */
function classificationEffect(changed: boolean, classification: Classification): string | null {
  if (!changed) return null;
  if (classification === 'OPERATIONAL') return 'Saving makes every version of this policy readable by every employee of the company.';
  return 'Saving makes every version of this policy readable only by holders of the confidential policy grant.';
}

function PolicyChangeForm({ policy }: { policy: PolicyDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canConfidential = can(POLICY_MANAGE_CONFIDENTIAL);
  const [title, setTitle] = useState(policy.title);
  const [classification, setClassification] = useState<Classification>(policy.classification);
  const [saved, setSaved] = useState(false);
  // Whenever the policy changes (this save, or someone else's change found on a reload) the form shows it as it is now.
  useEffect(() => {
    setTitle(policy.title);
    setClassification(policy.classification);
  }, [policy.version, policy.title, policy.classification]);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policy(policy.id) });
    void qc.invalidateQueries({ queryKey: keys.policies });
  };
  const titleChanged = title.trim() !== policy.title;
  const classificationChanged = classification !== policy.classification;
  const save = useMutation({
    mutationFn: () =>
      api<PolicyDetail>(`/v1/company-policies/${encodeURIComponent(policy.id)}`, {
        method: 'PATCH',
        body: { expectedVersion: policy.version, ...(titleChanged ? { title: title.trim() } : {}), ...(classificationChanged ? { classification } : {}) },
      }),
    onMutate: () => setSaved(false),
    onSuccess: (updated) => {
      qc.setQueryData(keys.policy(policy.id), updated);
      setSaved(true);
      reload();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') reload();
    },
  });
  // A confidential policy, or a change to or from confidential, needs the confidential manage group (DF02).
  const locked = policy.classification === 'CONFIDENTIAL' && !canConfidential;
  const ready = !locked && (titleChanged || classificationChanged) && title.trim() !== '' && !save.isPending;
  const effect = classificationEffect(classificationChanged, classification);
  return (
    <Section title="Title and classification">
      {locked ? (
        <NotPermitted>Changing a confidential policy also needs the confidential policy grant.</NotPermitted>
      ) : (
        <FormGrid
          aria-label="Title and classification"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <FormField className="col-span-full">
            Title
            <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
          <FormField>
            Classification
            <NativeSelect value={classification} onChange={(e) => setClassification(e.target.value as Classification)}>
              <option value="OPERATIONAL">Operational (every employee of the company)</option>
              {(canConfidential || policy.classification === 'CONFIDENTIAL') && <option value="CONFIDENTIAL">Confidential (confidential policy grant only)</option>}
            </NativeSelect>
          </FormField>
          <div className="col-span-full">
            <Button type="submit" disabled={!ready}>
              Save
            </Button>
          </div>
        </FormGrid>
      )}
      <Hint>The classification belongs to the policy, so it applies to every version, earlier ones included.</Hint>
      {effect && (
        <StatusNote tone="info" role="status">
          {effect}
        </StatusNote>
      )}
      {saved && <Notice notice={{ text: 'Saved.', ok: true }} />}
      <Refusal error={save.error} words={CHANGE_WORDS} />
    </Section>
  );
}
