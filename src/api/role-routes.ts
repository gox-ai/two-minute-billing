import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { badRequest, noMemberPermission, requirePerm } from "./helpers";
import { parseRequest } from "./strict-params";
import { LIMITS } from "./limits";
import { KEY_RESOURCES, PERMISSIONS } from "@/modules/auth/permissions";
import {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  updateRole,
  RoleError,
  PermissionEscalationError,
  type RoleActor,
  type RoleView,
} from "@/modules/auth/roles";

const permissionList = z.array(z.string().max(64)).max(200);

const createBody = z.object({
  name: z.string().max(200),
  description: z.string().max(1000).nullish(),
  permissions: permissionList,
});
const updateBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(1000).nullish(),
  permissions: permissionList.optional(),
  version: z.number().int().positive().optional(),
});

function serialize(v: RoleView) {
  return {
    object: "role",
    id: v.row.publicId,
    name: v.row.name,
    description: v.row.description,
    permissions: v.row.permissions,
    version: v.row.version,
    member_count: v.memberCount,
    created_at: v.row.createdAt,
    updated_at: v.row.updatedAt,
  };
}

function actorOf(req: FastifyRequest): RoleActor {
  return {
    email: req.operatorEmail!,
    permissions: req.operatorPermissions!,
    customRoleId: req.operatorCustomRoleId ?? null,
  };
}

function roleErrorReply(reply: FastifyReply, e: unknown) {
  if (e instanceof PermissionEscalationError)
    return reply.code(403).send({
      error: { type: "permission_error", code: "permission_escalation", message: e.message },
    });
  if (e instanceof RoleError)
    return reply.code(e.status).send({
      error: {
        type:
          e.status === 404
            ? "invalid_request_error"
            : e.status === 409
              ? "conflict"
              : "invalid_request_error",
        message: e.message,
      },
    });
  throw e;
}

/** Custom roles (0389) and the permission catalogue. Roles are for signed-in members only. */
export async function registerRoleRoutes(app: FastifyInstance) {
  // The static catalogue: what a role or an API key map can name.
  app.get(
    "/v1/permissions",
    { preHandler: [authenticate, noMemberPermission("the static permission catalogue")] },
    async () => ({
      object: "list",
      data: PERMISSIONS.map((p) => ({
        object: "permission",
        key: p.key,
        resource: p.resource,
        mode: p.mode,
        area: p.area,
        label: p.label,
        members_only: !!p.operatorOnly,
      })),
      key_resources: KEY_RESOURCES,
    }),
  );

  app.get("/v1/roles", { preHandler: [authenticate, requirePerm("roles:view")] }, async (req) => {
    const rows = await listRoles(req.organization!.id);
    return { object: "list", data: rows.map(serialize) };
  });

  app.get(
    "/v1/roles/:id",
    { preHandler: [authenticate, requirePerm("roles:view")] },
    async (req, reply) => {
      try {
        return serialize(await getRole(req.organization!.id, (req.params as { id: string }).id));
      } catch (e) {
        return roleErrorReply(reply, e);
      }
    },
  );

  app.post(
    "/v1/roles",
    {
      preHandler: [authenticate, requirePerm("roles:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const v = await createRole(req.organization!.id, actorOf(req), parsed.data);
        return reply.code(201).send(serialize(v));
      } catch (e) {
        return roleErrorReply(reply, e);
      }
    },
  );

  app.patch(
    "/v1/roles/:id",
    {
      preHandler: [authenticate, requirePerm("roles:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const id = (req.params as { id: string }).id;
      if (id.length > LIMITS.id) return badRequest(reply, "id is too long");
      try {
        return serialize(await updateRole(req.organization!.id, actorOf(req), id, parsed.data));
      } catch (e) {
        return roleErrorReply(reply, e);
      }
    },
  );

  app.delete(
    "/v1/roles/:id",
    {
      preHandler: [authenticate, requirePerm("roles:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        await deleteRole(req.organization!.id, actorOf(req), id);
        return { object: "role", id, deleted: true };
      } catch (e) {
        return roleErrorReply(reply, e);
      }
    },
  );
}
