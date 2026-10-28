export type FieldKind = "text" | "textarea" | "email" | "tel" | "url" | "number" | "date" | "select" | "combobox" | "radio" | "checkbox" | "checkbox-group" | "file";
export interface FieldSpec { id: string; label: string; kind: FieldKind; required: boolean; options?: string[]; maxLength?: number; description?: string }
export type FieldAnswer = { type: "text"; text: string } | { type: "option"; option: string } | { type: "options"; options: string[] } | { type: "check"; checked: boolean } | { type: "file"; path: string };
export interface JobContext { jobId: string; company: string; title: string; location: string; term: string | null; description?: string }
