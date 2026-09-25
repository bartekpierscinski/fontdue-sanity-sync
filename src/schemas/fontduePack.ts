import { defineField, defineType } from "sanity";
import type { SchemaOptions } from "./types.js";
import { softDeleteFields } from "./softDeleteFields.js";

/**
 * A font pack mirrored from Fontdue: its identity, visibility, style count
 * and members, in Fontdue's order. Members reference the synced
 * `fontdueCollection` (a whole family or superfamily) and `fontdueStyle`
 * (a single style) documents.
 *
 * Prices are deliberately not mirrored: they are live data, and writing
 * them here would wake every webhook on each price edit. Read them from the
 * Fontdue API at render time by `fontdueId`.
 */
export function createFontduePack(options?: SchemaOptions) {
  const includeSoftDelete = options?.includeSoftDelete === true;
  const packIcon = options?.icons?.pack;

  return defineType({
    name: "fontduePack",
    title: "Font Pack",
    type: "document",
    readOnly: true,
    fields: [
      defineField({
        name: "fontdueId",
        title: "Fontdue ID",
        type: "string",
        validation: (Rule) => Rule.required(),
      }),
      defineField({
        name: "name",
        title: "Name",
        type: "string",
      }),
      defineField({
        name: "slug",
        title: "Slug",
        type: "string",
      }),
      defineField({
        name: "visibility",
        title: "Visibility",
        type: "string",
        description:
          "Unlisted packs are for sale but left out of the Store Modal's list of packs. Hidden packs never sync.",
        options: {
          list: [
            { title: "Visible", value: "visible" },
            { title: "Unlisted", value: "unlisted" },
          ],
        },
      }),
      defineField({
        name: "totalStyles",
        title: "Styles",
        type: "number",
        description: "How many styles the pack grants, as counted by Fontdue",
      }),
      defineField({
        name: "members",
        title: "Members",
        type: "array",
        description:
          "What the pack contains, in Fontdue's order: whole families or superfamilies, or single styles",
        of: [
          {
            type: "reference",
            to: [{ type: "fontdueCollection" }, { type: "fontdueStyle" }],
          },
        ],
      }),
      ...(includeSoftDelete ? softDeleteFields() : []),
    ],
    preview: {
      select: {
        title: "name",
        totalStyles: "totalStyles",
        members: "members",
        visibility: "visibility",
        isDeleted: "isDeleted",
      },
      prepare({ title, totalStyles, members, visibility, isDeleted }) {
        const parts: string[] = [];
        if (typeof totalStyles === "number") {
          parts.push(`${totalStyles} ${totalStyles === 1 ? "style" : "styles"}`);
        }
        const memberCount = Array.isArray(members) ? members.length : 0;
        parts.push(`${memberCount} ${memberCount === 1 ? "member" : "members"}`);
        if (visibility === "unlisted") parts.push("unlisted");
        if (isDeleted) parts.push("removed from Fontdue");

        return {
          title,
          subtitle: parts.join(" · "),
          ...(packIcon ? { media: packIcon } : {}),
        };
      },
    },
  });
}
