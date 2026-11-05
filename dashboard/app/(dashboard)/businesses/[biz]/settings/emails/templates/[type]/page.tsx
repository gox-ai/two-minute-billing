import { requirePermission, currentUser } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { SettingsPage } from "@/components/settings/settings-layout";
import { TemplateEditor } from "@/components/emails/template-editor";
import { getEmailTemplate, previewEmailTemplate, type EmailPreview } from "@/lib/api/emails";
import { EMAIL_TYPES } from "@/lib/email-types";
import {
  saveTemplateAction,
  sendTemplateTestAction,
  saveAttachmentRuleAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

/**
 * Editor for one billing email template: cards on the left, the engine-rendered preview
 * on the right. The first preview renders here so the pane is never empty; drafts
 * re-render through /api/email-preview, the same engine endpoint.
 */
export default async function EmailTemplateEditorPage({
  params,
}: {
  params: Promise<{ biz: string; type: string }>;
}) {
  const { biz, type } = await params;
  await requirePermission("emails:view", "admin");
  const user = await currentUser();

  const meta = EMAIL_TYPES.find((t) => t.key === type);
  // An unknown type is a bad URL, not an empty editor — rendering a form that will 400 on
  // save is exactly the dead control the copy-UI rule forbids. ErrorState rather than
  // notFound(): this route group has no not-found boundary, so notFound() renders the
  // shell with an EMPTY main pane and a 200, which reads as a broken page rather than a
  // wrong address. (Measured, 2026-08-09.)
  if (!meta) {
    return (
      <ErrorState
        title="Unknown email type"
        description={
          <>
            <span className="font-mono text-xs">{type}</span> is not a billing email we send. Known
            types: {EMAIL_TYPES.map((t) => t.key).join(", ")}.
          </>
        }
      />
    );
  }

  let template;
  try {
    template = await getEmailTemplate(biz, type);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }

  // Best-effort: a failed preview must not take the editor down with it, since editing
  // and saving still work without one.
  let initialPreview: EmailPreview | null = null;
  const res = await previewEmailTemplate(biz, type, {});
  if (res.ok) initialPreview = res.data as EmailPreview;

  return (
    <SettingsPage
      title={meta.label}
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Email notifications", href: `/businesses/${biz}/settings/emails` },
        { label: meta.label },
      ]}
      description={meta.description}
    >
      <TemplateEditor
        biz={biz}
        label={meta.label}
        template={{
          type: template.type,
          subject: template.subject,
          heading: template.heading,
          body: template.body,
          footer: template.footer,
          cta_label: template.cta_label,
          show_facts: template.show_facts,
          block_order: template.block_order,
          default_cta_label: template.default_cta_label,
          has_facts: template.has_facts,
          default_footer: template.default_footer,
          built_in: template.built_in,
          customized: template.customized,
          inherits_from: template.inherits_from ?? null,
          updated_at: template.updated_at,
          variables: template.variables,
          attachments: template.attachments,
        }}
        initialPreview={
          initialPreview
            ? {
                subject: initialPreview.subject,
                html: initialPreview.html,
                text: initialPreview.text,
                issues: initialPreview.issues ?? [],
              }
            : null
        }
        userEmail={user?.email ?? ""}
        saveAction={saveTemplateAction as never}
        testAction={sendTemplateTestAction as never}
        attachmentAction={saveAttachmentRuleAction}
      />
    </SettingsPage>
  );
}
