import { defineField, defineType } from "sanity";
import type { SchemaOptions } from "./types.js";

export function createFontdueLicense(options?: SchemaOptions) {
  const licenseIcon = options?.icons?.license;

  return defineType({
    name: "fontdueLicense",
    title: "Fontdue License",
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
    ],
    preview: {
      select: { title: "name" },
      prepare({ title }) {
        return {
          title,
          ...(licenseIcon ? { media: licenseIcon } : {}),
        };
      },
    },
  });
}
