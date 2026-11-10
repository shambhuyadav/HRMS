-- 0247 The external email channel (FR-085 "configurable supported channels ... delivery attempts, retry limits and visible
-- failed-delivery outcomes"; DF12 "Email may be enabled for non-confidential event templates after actual service configuration
-- and safe recipient tests"; BR-044; FR-061). 0010 allowed IN_APP only "until enabled"; this adds EMAIL beside it.
--
--   No email rule is created here or by provisioning: a company enables email for one event by proposing an EMAIL rule from that
--   event's in-app rule (POST /notifications/rules/:code/email), which comes into force only once someone else publishes it (0133).
--   FR-085 "supported channels and limits are explicitly configured, with no assumed default".
--   An email notification is queued by the dispatcher with its content already rendered, after the same recipient, preference and
--   delivery-time checks as in-app, and is sent by the worker only (modules/notification/email-delivery.ts); nothing is ever sent
--   while the worker has no SMTP settings: such a notice is SUPPRESSED with EMAIL_NOT_CONFIGURED, so the delivery log says so.
--   email_next_attempt_at   when the worker may next try it (null: not waiting)
--   email_sending_since     set by the worker's claim, committed before anything is sent: a second worker never takes it, and a
--                           send whose outcome was never recorded is settled FAILED (OUTCOME_UNKNOWN), never sent again (at most once)
alter table notification_template drop constraint notification_template_channel_check,
  add constraint notification_template_channel_check check (channel in ('IN_APP', 'EMAIL'));
alter table notification_rule drop constraint notification_rule_channel_check,
  add constraint notification_rule_channel_check check (channel in ('IN_APP', 'EMAIL'));
alter table notification_preference drop constraint notification_preference_channel_check,
  add constraint notification_preference_channel_check check (channel in ('IN_APP', 'EMAIL'));
alter table notification drop constraint notification_channel_check,
  add constraint notification_channel_check check (channel in ('IN_APP', 'EMAIL'));

alter table notification
  add column email_next_attempt_at timestamptz,
  add column email_sending_since timestamptz,
  -- Only an email waits for the worker, and only while it is open; it waits or is being sent, never both.
  add constraint notification_email_schedule check (channel = 'EMAIL' or (email_next_attempt_at is null and email_sending_since is null)),
  add constraint notification_email_open check (state in ('QUEUED', 'RETRY_PENDING') or (email_next_attempt_at is null and email_sending_since is null)),
  add constraint notification_email_one_step check (email_next_attempt_at is null or email_sending_since is null),
  -- The inbox is in-app: an email is never "read" there.
  add constraint notification_email_not_read check (channel = 'IN_APP' or read_at is null);

-- The worker's claim: the next due email per company in turn; and the sweep of sends whose worker died.
create index notification_email_due_idx on notification (company_id, email_next_attempt_at)
  where channel = 'EMAIL' and email_next_attempt_at is not null;
create index notification_email_sending_idx on notification (email_sending_since)
  where email_sending_since is not null;

-- BR-034 "no duplicate application notification": one delivery per notification, whatever the channel or the number of workers.
create unique index notification_delivery_attempt_one_delivered on notification_delivery_attempt (company_id, notification_id)
  where outcome = 'DELIVERED';

-- An email is DELIVERED only by the send that claimed it (direct writes too, CI18): no other path marks one sent.
create function hrms_notification_email_delivery() returns trigger language plpgsql as $$
begin
  if new.channel = 'EMAIL' and new.state = 'DELIVERED' and old.state <> 'DELIVERED' and old.email_sending_since is null then
    raise exception 'an email notification is delivered only by the send that claimed it' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger notification_email_delivery before update on notification for each row execute function hrms_notification_email_delivery();

-- DF12, BR-044: an email template may use only placeholders that carry a state or a step, never a name, code, date, period, title,
-- amount or reason (modules/notification/email-content.ts EMAIL_SAFE_PLACEHOLDERS holds the same list).
create function hrms_notification_email_template() returns trigger language plpgsql as $$
begin
  if new.channel = 'EMAIL' and not (new.approved_placeholders <@ array['outcome', 'step', 'stepLabel', 'runState', 'paymentEvent', 'paymentStatus', 'requestKind']::text[]) then
    raise exception 'an email template may use state placeholders only' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger notification_email_template before insert or update on notification_template for each row execute function hrms_notification_email_template();
