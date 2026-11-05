/**
 * What `tmbilling_app` and PUBLIC may do, read from the catalog rather than from a dump, so a
 * dump-flag regression cannot hide a lost grant. One line per (object, grantee, privilege).
 * A NULL ACL counts as the owner's default (PUBLIC executes a function until revoked).
 */
import type postgres from "postgres";

export async function privilegeMatrix(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    with app as (select oid from pg_roles where rolname = 'tmbilling_app'),
    objs as (
      select 'schema' as kind, n.nspname::text as name,
             coalesce(n.nspacl, acldefault('n'::"char", n.nspowner)) as acl
        from pg_namespace n
       where n.nspname in ('public', 'graphile_worker')
      union all
      select case c.relkind when 'S' then 'sequence' else 'table' end,
             n.nspname || '.' || c.relname,
             coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'graphile_worker') and c.relkind in ('r', 'v', 'm', 'p', 'S')
      union all
      select 'column', n.nspname || '.' || c.relname || '.' || a.attname, a.attacl
        from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'graphile_worker') and a.attacl is not null
      union all
      select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
             coalesce(p.proacl, acldefault('f'::"char", p.proowner))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    )
    select o.kind || ' ' || o.name || ' ' ||
           case when x.grantee = 0 then 'PUBLIC' else 'tmbilling_app' end || ' ' || x.privilege_type as line
      from objs o, aclexplode(o.acl) x
     where x.grantee = 0 or x.grantee = (select oid from app)
     order by 1`;
  return rows.map((r) => r.line);
}

/** Lines only in `a`, and lines only in `b`. */
export function diffMatrix(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) };
}
