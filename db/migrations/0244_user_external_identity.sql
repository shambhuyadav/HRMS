-- ADR-06 production sign-in (decided by the owner, 9 Nov 2026: Keycloak, self-hosted, as the OIDC provider; T-03): the identity a person
-- signs in with at the provider (its issuer and subject) is linked to one HRMS account. The first verified sign-in links them, matching
-- the provider's verified email to the account key; from then on the link alone decides, so an email later given to someone else at the
-- provider never opens the account. One link per account and provider, one account per provider identity; a link is never changed or
-- removed (a person who must sign in with a new identity is a decision for an administrator, recorded as a new account or a migration).
create table user_external_identity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references user_account (id) on delete restrict,
  -- The provider's issuer exactly as its tokens state it.
  issuer      text not null check (issuer ~ '^https?://[^\s]+$' and length(issuer) <= 500),
  -- The provider's stable subject for the person (never the email).
  subject     text not null check (btrim(subject) <> '' and length(subject) <= 255),
  created_at  timestamptz not null default now(),
  unique (issuer, subject),
  unique (user_id, issuer)
);

create trigger user_external_identity_append_only before update or delete on user_external_identity for each row execute function hrms_append_only();
