# Release notes body for TAG: PR bullets from GitHub's generator plus the
# mainline commits that never became a PR. Run from the repo root.
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_OUTPUT.
param(
  [int]$Limit = 10,
  [switch]$SelfTest
)

# The newest stay open; the rest folds away so the notes open short.
function Fold($heading, $items) {
  $out = @($heading) + @($items | Select-Object -First $Limit)
  if ($items.Count -gt $Limit) {
    $out += @('', "<details><summary>$($items.Count - $Limit) more</summary>", '')
    $out += @($items | Select-Object -Skip $Limit)
    $out += @('', '</details>')
  }
  $out
}

# A many-commit PR carries its own list, folded so the notes stay short.
function CommitBlock($items) {
  if ($items.Count -lt 2) { return @() }
  $out = @("  <details><summary>$($items.Count) commits</summary>", '')
  $out += @($items | ForEach-Object { "  $_" })
  $out + @('', '  </details>')
}

if ($SelfTest) {
  $fail = @()
  $short = Fold '### Pull requests' @('* a', '* b')
  if ($short.Count -ne 3) { $fail += "short fold: $($short.Count) lines" }
  if ($short -match '<details>') { $fail += 'short fold opened a dropdown' }
  $long = Fold '### Pull requests' @(1..23 | ForEach-Object { "* bullet $_" })
  if ($long[0] -ne '### Pull requests') { $fail += "heading lost: $($long[0])" }
  if ($long -notcontains '<details><summary>13 more</summary>') { $fail += 'summary missing' }
  $body = $long -join "`n"
  $open = $body.Split('<details>')[0]
  if (($open -split "`n" | Where-Object { $_ -like '* bullet *' }).Count -ne 10) { $fail += 'wrong number of open bullets' }
  if (($body -split "`n" | Where-Object { $_ -like '* bullet *' }).Count -ne 23) { $fail += 'bullets lost in the fold' }
  if ($long[-1] -ne '</details>') { $fail += 'dropdown left open' }
  $single = CommitBlock @('* only')
  if ($single.Count) { $fail += 'a one-commit PR grew a dropdown' }
  $many = CommitBlock @('* one', '* two', '* three')
  if ($many[0] -ne '  <details><summary>3 commits</summary>') { $fail += "commit summary: $($many[0])" }
  if ($many -notcontains '  * two') { $fail += 'commits are not indented into the bullet' }
  if ($many[-1] -ne '  </details>') { $fail += 'commit dropdown left open' }
  if ($fail) { $fail | ForEach-Object { Write-Error $_ }; exit 1 }
  'self-test ok'
  exit 0
}

$tag = $env:TAG
$repo = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY"
$prev = git tag --list 'v*' --sort=-v:refname |
  Where-Object { $_ -ne $tag } | Select-Object -First 1
# A dispatch runs before its tag exists; the checked-out commit is the target.
$target = if (git rev-parse --verify --quiet "refs/tags/$tag" 2>$null) {
  $tag
} else {
  (git rev-parse HEAD)  # the API cannot resolve "HEAD"
}
$global:LASTEXITCODE = 0
if ($prev) {
  $request = @{ tag_name = $tag; previous_tag_name = $prev }
  $compare = "$repo/compare/$prev...$target"
} else {
  $request = @{ tag_name = $tag }
  $compare = "$repo/commits/$target"
}

$raw = $request | ConvertTo-Json |
  gh api "repos/$env:GITHUB_REPOSITORY/releases/generate-notes" --method POST --input -
# A notes hiccup must not block the release: the changelog still ships.
$generated = if ($LASTEXITCODE -eq 0 -and $raw) { ($raw | ConvertFrom-Json).body } else { "" }
$global:LASTEXITCODE = 0

$bullets = @()
$skip = $false
foreach ($line in $generated -split "`n") {
  if ($line -match '^##\s+(.+)$') {
    # "What's Changed" opens the list; every later section (new contributors)
    # is not a change and is dropped with its heading.
    if ($matches[1] -notmatch "What.s Changed") { $skip = $true }
    continue
  }
  if (-not $skip -and $line.TrimStart().StartsWith('* ')) {
    $bullets += $line.Trim()
  }
}

# Commits that reached main without a PR: the generated notes above only ever
# describe pulls, so these would go unmentioned.
$commits = @()
$commitPath = if ($prev) {
  "repos/$env:GITHUB_REPOSITORY/compare/$($prev)...$target"
} else {
  "repos/$env:GITHUB_REPOSITORY/commits?sha=$target&per_page=100"
}
# A compare answer nests its commits, a plain listing does not.
# --paginate: a large range spans pages, and gh would silently drop the rest.
$rows = gh api --paginate $commitPath --jq '(if type == "object" then .commits else . end) | .[] | [.sha, (.commit.message | split("\n")[0]), (.author.login // "")] | @tsv' 2>$null
if ($LASTEXITCODE -eq 0 -and $rows) {
  # Only the mainline: a PR's own commits are already summarised by its bullet,
  # and mainline merges carry no new information.
  $range = if ($prev) { "$prev..$target" } else { $target }
  $mainline = @(git rev-list --first-parent $range)
  $titles = @($bullets | ForEach-Object {
    if ($_ -match '^\* (.+?) by @') { $matches[1].ToLowerInvariant() }
  })
  foreach ($row in @($rows)) {
    $sha, $subject, $login = $row -split "`t", 3
    if (-not $subject -or -not $mainline.Contains($sha)) { continue }
    # A merge commit only restates the PR already listed above.
    if ($subject -like 'Merge *') { continue }
    # Squash and rebase merges restate the PR; the bullet has it.
    if ($titles -contains ($subject -replace '\s*\(#\d+\)$', '').ToLowerInvariant()) { continue }
    $link = "[$($sha.Substring(0, 7))]($repo/commit/$sha)"
    $commits += if ($login) { "* $subject by @$login in $link" } else { "* $subject in $link" }
  }
  # Newest first, as the PR bullets are.
  [array]::Reverse($commits)
}
$global:LASTEXITCODE = 0

# Each PR's own commits fold under its bullet: a 15-commit PR would otherwise
# arrive as one line and hide its work.
$bullets = @($bullets | ForEach-Object {
  $out = @($_)
  if ($_ -match '/pull/(\d+)') {
    $number = $matches[1]
    $prRows = gh api --paginate "repos/$env:GITHUB_REPOSITORY/pulls/$number/commits?per_page=100" --jq '.[] | [.sha, (.commit.message | split("\n")[0])] | @tsv' 2>$null
    if ($LASTEXITCODE -eq 0 -and $prRows) {
      $items = @(foreach ($row in @($prRows)) {
        $sha, $subject = $row -split "`t", 2
        if (-not $subject) { continue }
        "* $subject in [$($sha.Substring(0, 7))]($repo/commit/$sha)"
      })
      $out += CommitBlock $items
    }
    $global:LASTEXITCODE = 0
  }
  $out -join "`n"
})

$sections = @()
if ($bullets.Count) { $sections += Fold '### Pull requests' $bullets }
if ($commits.Count) {
  if ($sections.Count) { $sections += '' }
  $sections += Fold '### Direct commits' $commits
}
$body = (@($sections) + @('', "**Full changelog:** $compare")) -join "`n"
"body<<EOF" >> $env:GITHUB_OUTPUT
$body.Trim() >> $env:GITHUB_OUTPUT
"EOF" >> $env:GITHUB_OUTPUT
$body
