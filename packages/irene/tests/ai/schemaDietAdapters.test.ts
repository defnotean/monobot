import { describe, expect, it } from "vitest";

// @ts-expect-error - importing JS modules without types
import { ADMIN_TOOLS } from "../../ai/tools.js";
// @ts-expect-error - importing JS modules without types
import { normalizeChannelPermissionArgs } from "../../ai/executors/channelExecutor.js";
// @ts-expect-error - importing JS modules without types
import { normalizeRolePermissionArgs } from "../../ai/executors/roleExecutor.js";
// @ts-expect-error - importing JS modules without types
import { normalizeSetupTicketArgs, normalizeWelcomeArgs } from "../../ai/executors/setupExecutor.js";
// @ts-expect-error - importing JS modules without types
import { normalizeSendMessageArgs } from "../../ai/executors/messageExecutor.js";
// @ts-expect-error - importing JS modules without types
import { normalizeCustomCommandArgs, normalizeEditCustomCommandArgs } from "../../ai/executors/customCommandExecutor.js";
// @ts-expect-error - importing JS modules without types
import { normalizePurgeMessagesArgs } from "../../ai/executors/moderationExecutor.js";

const tool = (name: string) => ADMIN_TOOLS.find((entry: { name: string }) => entry.name === name)!;

describe("schema diet adapters", () => {
  it("normalizes role permission allow/deny arrays while preserving flat inputs", () => {
    const flat = { role_name: "Member", send_messages: true, manage_roles: false };
    expect(normalizeRolePermissionArgs(flat)).toEqual(flat);
    expect(normalizeRolePermissionArgs({
      role_name: "Member",
      allow: ["send_messages", "view_channels"],
      deny: ["manage_roles"],
    })).toMatchObject({
      role_name: "Member",
      send_messages: true,
      view_channels: true,
      manage_roles: false,
    });
  });

  it("normalizes channel permission allow/deny/inherit arrays while preserving flat inputs", () => {
    const flat = { target: "Member", target_type: "role", allow_view: true, allow_send: false };
    expect(normalizeChannelPermissionArgs(flat)).toEqual(flat);
    expect(normalizeChannelPermissionArgs({
      channel: { id: "123" },
      target: "Member",
      target_type: "role",
      allow: ["view", "read_history"],
      deny: ["send"],
      inherit: ["react"],
    })).toMatchObject({
      channel_id: "123",
      target: "Member",
      target_type: "role",
      allow_view: true,
      allow_read_history: true,
      allow_send: false,
      allow_react: null,
    });
  });

  it("normalizes welcome customization groups while preserving flat inputs", () => {
    const flat = { title: "Welcome", show_title: true, extra_fields: [{ name: "A", value: "B" }] };
    expect(normalizeWelcomeArgs(flat)).toEqual(flat);
    expect(normalizeWelcomeArgs({
      message: { title: "Welcome {user}", description: "Read rules", content: "hi", ping_user: true },
      style: { color: "blurple", show_title: true, show_thumbnail: false },
      media: { thumbnail_url: "none", banner_url: "https://cdn/banner.png", show_banner: true },
      author: { name: "{server}", icon_url: "none", url: "none", show: true },
      footer: { text: "footer", icon_url: "none", show: true, timestamp: true },
      fields: [{ key: "member", show: true, name: "Member #" }],
      ping_roles: "Mods",
    })).toMatchObject({
      title: "Welcome {user}",
      description: "Read rules",
      content: "hi",
      ping_user: true,
      color: "blurple",
      show_title: true,
      show_thumbnail: false,
      thumbnail_url: "none",
      banner_url: "https://cdn/banner.png",
      show_banner: true,
      show_author: true,
      author_name: "{server}",
      author_icon_url: "none",
      author_url: "none",
      show_footer: true,
      footer_text: "footer",
      footer_icon_url: "none",
      show_timestamp: true,
      show_member_field: true,
      member_field_name: "Member #",
      ping_roles: "Mods",
    });
  });

  it("normalizes ticket setup groups while preserving flat inputs", () => {
    const flat = { category: "Tickets", view_roles: ["Mods"], post_panel: true };
    expect(normalizeSetupTicketArgs(flat)).toEqual(flat);
    expect(normalizeSetupTicketArgs({
      category: "Tickets",
      roles: { view: ["Mods"], ping: ["Support"], view_auto: "staff", ping_auto: "admin" },
      welcome: { title: "Need help?", description: "Tell us what happened", color: "#5865F2" },
      panel: {
        title: "Open a ticket",
        description: "Click below",
        color: "#2b2d31",
        channel: "support",
        post: true,
        button: { label: "Open Ticket", emoji: "ticket" },
      },
      ticket_types: [{ key: "support", label: "Support" }],
      remove_ticket_types: ["old"],
    })).toMatchObject({
      category: "Tickets",
      view_roles: ["Mods"],
      ping_roles: ["Support"],
      view_auto_category: "staff",
      ping_auto_category: "admin",
      welcome_title: "Need help?",
      welcome_description: "Tell us what happened",
      welcome_color: "#5865F2",
      panel_title: "Open a ticket",
      panel_description: "Click below",
      panel_color: "#2b2d31",
      panel_channel: "support",
      post_panel: true,
      panel_button_label: "Open Ticket",
      panel_button_emoji: "ticket",
      ticket_types: [{ key: "support", label: "Support" }],
      remove_ticket_types: ["old"],
    });
  });

  it("normalizes send_message embed/components groups while preserving flat inputs", () => {
    const flat = { channel_name: "rules", content: "hi", embed_title: "Rules" };
    expect(normalizeSendMessageArgs(flat)).toEqual(flat);
    expect(normalizeSendMessageArgs({
      channel: { id: "123" },
      content: "hello",
      embed: {
        title: "Rules",
        description: "Be kind",
        color: "blue",
        image: "https://cdn/image.png",
        thumbnail: "https://cdn/thumb.png",
        author: { name: "Irene", icon: "https://cdn/a.png" },
        footer: { text: "footer", icon: "https://cdn/f.png" },
        fields: [{ name: "One", value: "Two" }],
        timestamp: true,
      },
      components: { buttons: [{ label: "Open", style: "primary", action: "open_ticket" }], dropdown: { options: [{ label: "Role", role_id: "r1" }] } },
    })).toMatchObject({
      channel_id: "123",
      content: "hello",
      embed_title: "Rules",
      embed_description: "Be kind",
      embed_color: "blue",
      embed_image: "https://cdn/image.png",
      embed_thumbnail: "https://cdn/thumb.png",
      embed_author: "Irene",
      embed_author_icon: "https://cdn/a.png",
      embed_footer: "footer",
      embed_footer_icon: "https://cdn/f.png",
      embed_fields: [{ name: "One", value: "Two" }],
      embed_timestamp: true,
      buttons: [{ label: "Open", style: "primary", action: "open_ticket" }],
      dropdown: { options: [{ label: "Role", role_id: "r1" }] },
    });
  });

  it("normalizes custom command groups while preserving flat inputs", () => {
    const flatCreate = { trigger: "rules", description: "Rules", response: "read them" };
    expect(normalizeCustomCommandArgs(flatCreate)).toEqual(flatCreate);
    expect(normalizeCustomCommandArgs({
      trigger: "rules",
      description: "Rules",
      response: "read them",
      embed: { title: "Rules", color: "blue", footer: "footer", author: "Irene" },
      roles: { give: "Member", remove: "Muted" },
      options: { admin_only: true, auto_delete: true },
    })).toMatchObject({
      trigger: "rules",
      description: "Rules",
      response: "read them",
      embed_title: "Rules",
      embed_color: "blue",
      embed_footer: "footer",
      embed_author: "Irene",
      role_to_give: "Member",
      role_to_remove: "Muted",
      admin_only: true,
      auto_delete: true,
    });

    const flatEdit = { trigger: "rules", cmd_description: "New", embed_color: "none" };
    expect(normalizeEditCustomCommandArgs(flatEdit)).toEqual(flatEdit);
    expect(normalizeEditCustomCommandArgs({
      trigger: "rules",
      description: "New",
      response: "updated",
      embed: { title: "Updated", color: "gold" },
      roles: { give: "VIP" },
      options: { admin_only: false },
    })).toMatchObject({
      trigger: "rules",
      cmd_description: "New",
      response: "updated",
      embed_title: "Updated",
      embed_color: "gold",
      role_to_give: "VIP",
      admin_only: false,
    });
  });

  it("normalizes purge filters/range while preserving flat inputs", () => {
    const flat = { count: 25, from_user: "bob", before_message_id: "10" };
    expect(normalizePurgeMessagesArgs(flat)).toEqual(flat);
    expect(normalizePurgeMessagesArgs({
      count: 50,
      channel: { name: "general" },
      filters: { from_user: "bob", content_type: "media", contains: "spam", has_links: true, is_pinned: false },
      range: { before_message_id: "10", after_date: "2025-01-01" },
    })).toMatchObject({
      count: 50,
      channel_name: "general",
      from_user: "bob",
      content_type: "media",
      contains: "spam",
      has_links: true,
      is_pinned: false,
      before_message_id: "10",
      after_date: "2025-01-01",
    });
  });
});

describe("compacted Irene schemas", () => {
  it("uses grouped schema properties and shorter descriptions for the fat tools", () => {
    for (const name of [
      "set_role_permissions",
      "set_channel_permissions",
      "customize_welcome",
      "setup_ticket",
      "send_message",
      "create_custom_command",
      "edit_custom_command",
      "purge_messages",
    ]) {
      expect(tool(name).description.length, name).toBeLessThanOrEqual(300);
    }

    expect(tool("set_role_permissions").input_schema.properties).toHaveProperty("allow");
    expect(tool("set_role_permissions").input_schema.properties).toHaveProperty("deny");
    expect(tool("set_role_permissions").input_schema.properties).not.toHaveProperty("manage_roles");
    expect(tool("set_channel_permissions").input_schema.properties).toHaveProperty("inherit");
    expect(tool("customize_welcome").input_schema.properties).toHaveProperty("message");
    expect(tool("setup_ticket").input_schema.properties).toHaveProperty("roles");
    expect(tool("send_message").input_schema.properties).toHaveProperty("embed");
    expect(tool("create_custom_command").input_schema.properties).toHaveProperty("embed");
    expect(tool("edit_custom_command").input_schema.properties).toHaveProperty("options");
    expect(tool("purge_messages").input_schema.properties).toHaveProperty("filters");
  });
});
