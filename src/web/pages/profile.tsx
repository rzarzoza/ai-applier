import type { Db } from "../../db/db.js";
import { getProfile, type Profile } from "../../profile/profile.js";
import { Alert, Layout, pauseProps } from "../layout.js";
import { PageHead } from "../ui.js";
import { inboxCount } from "./inbox.js";

type Kind = "text" | "bool" | "list";
type FieldKey = Exclude<keyof Profile, "resumePath" | "resumeText">;
interface Field { key: FieldKey; label: string; kind: Kind; hint?: string }

const f = (key: FieldKey, label: string, kind: Kind = "text", hint?: string): Field => ({ key, label, kind, hint });

export const PROFILE_GROUPS: { title: string; fields: Field[] }[] = [
  { title: "Contact", fields: [
    f("firstName", "First name"), f("lastName", "Last name"), f("preferredName", "Preferred name"), f("email", "Email"), f("phone", "Phone"),
    f("addressLine", "Address"), f("city", "City"), f("state", "State"), f("postalCode", "Postal code"), f("country", "Country"),
    f("linkedin", "LinkedIn"), f("github", "GitHub"), f("website", "Website"),
  ] },
  { title: "Education", fields: [
    f("school", "School"), f("degree", "Degree"), f("major", "Major"), f("gpa", "GPA"),
    f("graduationMonth", "Graduation month", "text", "YYYY-MM"), f("employers", "Employers", "list", "comma-separated"),
  ] },
  { title: "Work authorization", fields: [
    f("usCitizen", "US citizen", "bool"), f("workAuthorizedUS", "Authorized to work in the US", "bool"),
    f("requiresSponsorship", "Requires sponsorship", "bool"), f("willingToRelocate", "Willing to relocate", "bool"),
    f("earliestStart", "Earliest start date"),
  ] },
  { title: "Demographics", fields: [
    f("gender", "Gender"), f("sexualOrientation", "Sexual orientation"), f("pronouns", "Pronouns"), f("ethnicity", "Ethnicity"),
    f("hispanicLatino", "Hispanic or Latino", "bool"), f("veteranStatus", "Veteran status"), f("militarySpouse", "Military spouse", "bool"),
    f("disabilityStatus", "Disability status"), f("relatedToEmployee", "Related to an employee", "bool"),
  ] },
];

export const PROFILE_FIELDS: Field[] = PROFILE_GROUPS.flatMap(g => g.fields);

function Input(props: { field: Field; profile: Profile }) {
  const { field, profile } = props;
  const v = profile[field.key];
  if (field.kind === "bool") {
    return (
      <select name={field.key}>
        <option value="" selected={v === null}>Not set</option>
        <option value="yes" selected={v === true}>Yes</option>
        <option value="no" selected={v === false}>No</option>
      </select>
    );
  }
  const text = Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "";
  return <input type="text" name={field.key} value={text} placeholder={field.hint ?? ""} />;
}

export function ProfilePage(props: { db: Db; notice?: string; error?: string }) {
  const profile = getProfile(props.db);
  return (
    <Layout active="profile" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)} title="Profile">
      <PageHead title="Profile & resume" subtitle="What the applier knows about you. Every application is filled from here." />
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.error ? <Alert kind="danger">{props.error}</Alert> : null}
      <section class="card">
        <div class="card-head"><h2>Resume</h2></div>
        <div class="meta">{profile.resumePath ? "A resume is on file." : "No resume uploaded yet."} Uploading fills empty profile fields.</div>
        <form method="post" action="/profile/resume" enctype="multipart/form-data">
          <div class="row">
            <input type="file" name="resume" accept="application/pdf,.pdf" required />
            <button class="primary" type="submit">Upload PDF</button>
          </div>
        </form>
      </section>
      <form method="post" action="/profile">
        {PROFILE_GROUPS.map(g => (
          <section class="card">
            <div class="card-head"><h2>{g.title}</h2></div>
            <div class="fields-grid">
              {g.fields.map(field => (
                <label class="field">
                  <span>{field.label}</span>
                  <Input field={field} profile={profile} />
                </label>
              ))}
            </div>
          </section>
        ))}
        <div class="form-foot"><button class="primary" type="submit">Save profile</button></div>
      </form>
    </Layout>
  );
}
