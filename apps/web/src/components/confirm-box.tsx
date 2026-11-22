// A step that asks "are you sure?" before something hard to undo (the old `.confirm-box`): a warning Alert holding the question, any
// field it needs and its buttons, stacked, the words in the text colour. Unlike a plain Alert it has no role of its own: give it the
// role the old box had (role="group" with aria-label, role="status"), or draw it on a form with asChild, which keeps the form's role.
import { Alert, type AlertProps } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

/** The question, fields and buttons one under another; its paragraphs without their own margins, the box's gap spacing them. */
const STACKED = 'flex flex-col items-stretch gap-[0.6rem] text-foreground [&_p]:m-0';

export function ConfirmBox({ className, role, ...props }: AlertProps) {
  return <Alert variant="warning" role={role} className={cn(STACKED, className)} {...props} />;
}
