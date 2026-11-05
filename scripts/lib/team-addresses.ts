/**
 * Make addresses team members of an organization, so a TEST business may email them.
 *
 * Test mode sends only to team members (src/modules/emails/test-mode.ts). A suite that
 * needs a test business (test gateway, Time Travel) AND real delivery registers its
 * recipients here. Idempotent: a user row is shared across orgs, a membership is per org.
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";

export async function asTeamMembers(organizationId: string, ...emails: string[]): Promise<void> {
  for (const email of emails) {
    await systemDb.execute(sql`
      insert into users (public_id, email) values (${publicId("usr")}, ${email.toLowerCase()})
      on conflict (email) do nothing`);
    await systemDb.execute(sql`
      insert into memberships (organization_id, user_id, role)
      select ${organizationId}::uuid, id, 'admin' from users where email = ${email.toLowerCase()}
      on conflict (organization_id, user_id) do nothing`);
  }
}
