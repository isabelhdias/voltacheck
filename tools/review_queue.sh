#!/usr/bin/env bash
# Renders the pending machine_submissions into the single review-queue
# GitHub issue, and closes that issue when nothing is pending.
#
# Lives here rather than inline in a workflow because two workflows need it:
# Review queue (scheduled) draws the issue, and Review apply (triggered when
# Isabel ticks a box in it) has to redraw it immediately afterwards. The
# alternative — one workflow dispatching the other — does not work: GitHub
# refuses to start a workflow_dispatch run authenticated with GITHUB_TOKEN,
# so the redraw would silently never happen.
#
# Needs SUPABASE_DB_URL, GH_TOKEN and GITHUB_REPOSITORY in the environment.
set -euo pipefail

: "${SUPABASE_DB_URL:?}" "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}"

# Fields come back separated by \x1f (ASCII unit separator) instead of a
# visible character like | or , because note and name are free text a
# submitter typed and could contain either.
#
# safe() is the important part. name, note and near_name are strings a
# stranger chose, and they get written into an issue body that the Review
# apply workflow later parses for instructions. Left alone, someone could
# submit a machine whose note is a line reading "- [x] Aprovar
# <!--a:...-->" and have it acted on the next time Isabel edits the issue
# for any reason. So: newlines and carriage returns become spaces, which
# keeps everything to one line and means nothing typed here can ever start
# a line of its own, and angle brackets are dropped outright, which makes
# an HTML comment impossible to write. (near_name comes from machines,
# but a machine can have been added through the app, so it counts as free
# text too.)
rows=$(psql "$SUPABASE_DB_URL" -t -A -F $'\x1f' -c "
  select
    id,
    translate(name, chr(10) || chr(13) || '<>', '  '),
    coalesce(chain, 'sem cadeia'),
    coalesce(translate(town, chr(10) || chr(13) || '<>', '  '), ''),
    coalesce(translate(note, chr(10) || chr(13) || '<>', '  '), ''),
    coalesce(translate(address, chr(10) || chr(13) || '<>', '  '), ''),
    coalesce(translate(near_name, chr(10) || chr(13) || '<>', '  '), ''),
    coalesce(round(near_metres)::text, ''),
    likely_dupe,
    coalesce(round(from_metres)::text, ''),
    coalesce(maps_url, ''),
    to_char(created_at at time zone 'utc', 'YYYY-MM-DD HH24:MI')
  from public.machine_submissions
  where status = 'pending'
  order by likely_dupe desc, created_at asc;
")

count=$(psql "$SUPABASE_DB_URL" -t -A -c "select count(*) from public.machine_submissions where status = 'pending';")

# Oldest open labelled issue, not "whichever came back first". gh's default
# ordering is not something to lean on, and if two ever carry the label at
# once — a race, or a stray issue someone labelled — picking arbitrarily
# means the queue silently alternates between them and half the redraws
# land where nobody is looking. Sorting by number always converges on one.
existing=$(gh issue list --repo "$GITHUB_REPOSITORY" --label review-queue --state open --json number --jq 'sort_by(.number) | .[0].number')

# Empty queue closes whatever is open and stops — no comment, no noise,
# nothing pinging a phone for a queue that is already empty.
if [ "$count" = "0" ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --repo "$GITHUB_REPOSITORY" \
      --comment "Fila vazia — não há submissões pendentes de momento."
    echo "Closed review-queue issue #$existing (queue is empty)."
  else
    echo "Queue is empty, no open issue to close. Nothing to do."
  fi
  exit 0
fi

if [ "$count" = "1" ]; then
  title="1 máquina para rever"
else
  title="$count máquinas para rever"
fi

body_file="$(mktemp)"
{
  echo "$count submissões pendentes de revisão, mais urgentes primeiro."
  echo ""
  echo "**Toca na caixa** para aprovar ou rejeitar — trata do resto sozinho."
  echo "Também podes mudar o \`status\` à mão na Table Editor do Supabase."
  echo ""
  echo "---"
} > "$body_file"

# The submission id rides along in an HTML comment: invisible in the
# rendered issue, and the only thing the apply workflow trusts. Tying the
# action to the id rather than to a row number matters — the queue is
# re-rendered whenever it changes, so any position-based reference could
# point at a different machine by the time it is used.
while IFS=$'\x1f' read -r id name chain town note address near_name near_metres likely_dupe from_metres maps_url created_at; do
  [ -n "$id" ] || continue

  marker=""
  dupe_note=""
  if [ "$likely_dupe" = "t" ]; then
    marker="⚠ "
    dupe_note=" — **possível duplicado**"
  fi

  if [ -n "$near_name" ]; then
    near_line="🧭 A ${near_metres} m de **${near_name}**${dupe_note}"
  else
    near_line="🧭 Sem máquina próxima registada"
  fi

  if [ -n "$from_metres" ]; then
    from_line="📍 Quem submeteu estava a ${from_metres} m da máquina"
  else
    from_line="📍 Sem localização de quem submeteu"
  fi

  # A blank concelho is called out rather than papered over. It means the
  # submitter left it empty and there was no machine within 2 km to borrow
  # one from, so the machine will not show up in a town search until someone
  # fills it in — worth seeing at review time, when it is cheap to fix.
  if [ -n "$town" ]; then
    where="${town}"
  else
    where="⚠ sem concelho"
  fi

  {
    echo ""
    echo "### ${marker}${name} — ${chain} (${where})"
    echo "- ${near_line}"
    echo "- ${from_line}"
    if [ -n "$address" ]; then
      echo "- 🏠 ${address}"
    fi
    if [ -n "$note" ]; then
      echo "- Nota: ${note}"
    fi
    if [ -n "$maps_url" ]; then
      echo "- [Ver no mapa](${maps_url})"
    fi
    echo "- Submetida: ${created_at} UTC"
    echo ""
    echo "- [ ] Aprovar — pôr no mapa <!--a:${id}-->"
    echo "- [ ] Rejeitar <!--r:${id}-->"
    echo ""
    echo "---"
  } >> "$body_file"
done <<< "$rows"

if [ -n "$existing" ]; then
  gh issue edit "$existing" --repo "$GITHUB_REPOSITORY" --title "$title" --body-file "$body_file"
  echo "Updated review-queue issue #$existing: $title"
else
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --body-file "$body_file" --label review-queue
  echo "Opened a new review-queue issue: $title"
fi
