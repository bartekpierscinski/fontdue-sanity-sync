import { defineField, defineType } from "sanity";
import type { SchemaOptions } from "./types.js";

export function createFontdueStyle(options?: SchemaOptions) {
  const includeFamilyRef = options?.includeFamilyRef === true;
  const styleIcon = options?.icons?.style;

  const fields = [
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
    ...(includeFamilyRef
      ? [
          defineField({
            name: "family",
            title: "Family",
            type: "reference",
            to: [{ type: "fontdueCollection" }],
            description: "The font family this style belongs to",
          }),
        ]
      : []),
  ];

  return defineType({
    name: "fontdueStyle",
    title: "Fontdue Style",
    type: "document",
    readOnly: true,
    fields,
    preview: {
      select: {
        title: "name",
        ...(includeFamilyRef ? { familyName: "family.name" } : {}),
      },
      prepare(selection) {
        const { title } = selection;
        const familyName =
          "familyName" in selection ? selection.familyName : undefined;

        return {
          title,
          ...(familyName ? { subtitle: familyName } : {}),
          ...(styleIcon ? { media: styleIcon } : {}),
        };
      },
    },
  });
}
