import { useEffect, useState } from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { PersonDetails } from "../lib/types";
import { PosterCard, Row } from "../components/media";
import { Button, EmptyState, Loading } from "../components/ui";

const DAY: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };

// A face is often reopened, and a person's facts barely change.
const PERSON_CACHE = new Map<number, PersonDetails>();

/** Birthday, death and age on one line, the way Nuvio writes it. */
function bornLabel(person: PersonDetails): string | null {
  if (!person.birthday) return null;
  const born = new Date(person.birthday);
  if (Number.isNaN(born.getTime())) return person.birthday;
  const died = person.deathday ? new Date(person.deathday) : null;
  const alive = died === null || Number.isNaN(died.getTime());
  const end = alive ? new Date() : (died as Date);
  let age = end.getFullYear() - born.getFullYear();
  const beforeBirthday =
    end.getMonth() < born.getMonth() ||
    (end.getMonth() === born.getMonth() && end.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  const parts = [born.toLocaleDateString(undefined, DAY)];
  if (!alive) parts.push(`died ${end.toLocaleDateString(undefined, DAY)}`);
  if (age >= 0) parts.push(`${age} years`);
  return parts.join(" · ");
}

export function PersonView({ id }: { id: number }) {
  const { navigate } = useApp();
  const [person, setPerson] = useState<PersonDetails | null>(
    () => PERSON_CACHE.get(id) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .person(id)
      .then((result) => {
        if (!alive) return;
        PERSON_CACHE.set(id, result);
        setPerson(result);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!person) {
    return (
      <div className="page">
        {error ? (
          <EmptyState
            icon="info"
            title="Could not load this person"
            body={error}
            action={<Button onClick={() => navigate({ name: "home" })}>Back home</Button>}
          />
        ) : (
          <Loading variant="detail" label="Loading person" />
        )}
      </div>
    );
  }

  const born = bornLabel(person);
  const credits = person.credits
    ? `${person.credits} ${person.credits === 1 ? "title" : "titles"}${
        person.since ? ` · since ${person.since}` : ""
      }`
    : null;
  const rails = [
    ["Popular", person.popular],
    ["Latest", person.latest],
    ["Upcoming", person.upcoming],
  ].filter(([, items]) => items.length > 0) as Array<[string, typeof person.popular]>;

  return (
    <div className="page person-page">
      <div className="person-layout">
        <aside className="person-sidebar">
          <div className="person-portrait">
            {person.photo && !imageFailed ? (
              <img
                src={person.photo}
                alt={person.name}
                onError={() => setImageFailed(true)}
              />
            ) : (
              <span>{person.name.slice(0, 1)}</span>
            )}
          </div>
          <h1>{person.name}</h1>
          {person.department ? <p className="person-role">{person.department}</p> : null}
          <dl className="person-facts">
            {born ? (
              <div>
                <dt>Born</dt>
                <dd>{born}</dd>
              </div>
            ) : null}
            {person.placeOfBirth ? (
              <div>
                <dt>Place of birth</dt>
                <dd>{person.placeOfBirth}</dd>
              </div>
            ) : null}
            {credits ? (
              <div>
                <dt>Credits</dt>
                <dd>{credits}</dd>
              </div>
            ) : null}
          </dl>
          {person.biography ? (
            <section className="person-bio">
              <h2>Biography</h2>
              <p>{person.biography}</p>
            </section>
          ) : null}
        </aside>

        <div className="person-content">
          {rails.map(([title, items]) => (
            <Row title={title} key={title}>
              {items.map((item) => (
                <PosterCard
                  key={`${title}:${item.id}`}
                  item={item}
                  onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
                />
              ))}
            </Row>
          ))}
          {rails.length === 0 ? (
            <EmptyState
              icon={null}
              title="No credits yet"
              body="TMDB has no titles for this person."
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
