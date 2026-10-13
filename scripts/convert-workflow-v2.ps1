<#
.SYNOPSIS
  Convert workflow definitions written for ai-dev-kit 2.0.0 to the current format.

.DESCRIPTION
  Rewrites `.aidev/workflows/<name>/workflow.yaml` files written for aidev
  2.0.0 into the syntax the current kit accepts. The conversion is line-based,
  so comments, key order and formatting outside the converted keys are kept
  and the diff stays small enough to review.

  What changes (2.0.0 -> current):

    cost: { max_usd: N }          -> limits.max_usd: N
    limits.max_minutes omitted    -> limits.max_minutes: 60 (2.0.0's implicit
                                     default; -NoTimeLimit leaves it out)
    steps[].timeout_ms: N         -> steps[].timeout_minutes: N / 60000
    steps[].max_retries: N        -> steps[].until.max_retries: N
    kind: pull-request + title: T -> pull_request: { title: T }

  Nothing else in a 2.0.0 definition changed meaning. A file that already uses
  the current syntax is left as it is, so running the script twice is safe.

  When node and this kit's cli/lib/workflow.js are reachable, every converted
  file is validated with the same code `aidev run workflow` uses before it is
  written; a file that does not validate is not written (unless -Force).

  The converted workflow is a change like any other: review the diff and put
  it through `aidev submit workflow <name>` so it is approved again.

.PARAMETER Path
  Workflow files, or directories to search for them. For a directory holding
  `.aidev/workflows`, only `.aidev/workflows/*/workflow.yaml` is taken;
  otherwise every `workflow.yaml` under it. Defaults to the current directory.

.PARAMETER OutFile
  Write the result here instead of over the input. Only with a single file.

.PARAMETER NoTimeLimit
  Do not add `limits.max_minutes: 60` to a definition that had no time limit
  (2.0.0 applied 60 minutes implicitly; the current kit applies none).

.PARAMETER Backup
  Keep the original next to the converted file as `workflow.yaml.v2.bak`.

.PARAMETER Force
  Write the result even when it does not validate.

.EXAMPLE
  pwsh scripts/convert-workflow-v2.ps1 -Path C:\src\my-pkg -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\convert-workflow-v2.ps1 -Path .aidev\workflows\e2e-tests\workflow.yaml
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
  [Alias('FullName')]
  [string[]] $Path = @('.'),
  [string] $OutFile,
  [switch] $NoTimeLimit,
  [switch] $Backup,
  [switch] $Force
)

begin {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version Latest

  $KitRoot = Split-Path -Parent $PSScriptRoot
  $WorkflowLib = Join-Path (Join-Path (Join-Path $KitRoot 'cli') 'lib') 'workflow.js'
  # 2.0.0 stopped every run after 60 minutes unless limits.max_minutes said less.
  $V2DefaultMinutes = 60
  $inputs = New-Object System.Collections.Generic.List[string]
  $failed = 0

  function Write-Ok   { param([string] $Message) Write-Host "  [ok] $Message" -ForegroundColor Green }
  function Write-Note { param([string] $Message) Write-Host "       $Message" }
  function Write-Warn { param([string] $Message) Write-Host "  [!]  $Message" -ForegroundColor Yellow }
  function Write-Fail { param([string] $Message) Write-Host "  [x]  $Message" -ForegroundColor Red }

  function Get-Indent { param([string] $Line) return $Line.Length - $Line.TrimStart(' ').Length }

  # A line that carries no YAML node: blank, or a comment.
  function Test-Inert {
    param([string] $Line)
    $t = $Line.Trim()
    return ($t -eq '' -or $t.StartsWith('#'))
  }

  # "value  # comment" -> value, comment. Values converted here are numbers
  # and plain words, so a '#' after whitespace always starts a comment.
  function Split-Value {
    param([string] $Text)
    $m = [regex]::Match($Text, '^(.*?)(\s+#.*)?$')
    $comment = ''
    if ($m.Groups[2].Success) { $comment = $m.Groups[2].Value }
    return @{ Value = $m.Groups[1].Value.Trim(); Comment = $comment }
  }

  function Get-Unquoted {
    param([string] $Value)
    $v = $Value.Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
      return $v.Substring(1, $v.Length - 2)
    }
    return $v
  }

  # The value of `key` in a one-line flow mapping ("{ max_usd: 5, x: 1 }"), or $null.
  function Get-FlowValue {
    param([string] $Flow, [string] $Key)
    $m = [regex]::Match($Flow, "(?:^|[{,])\s*$([regex]::Escape($Key))\s*:\s*([^,}]+)")
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return $null
  }

  # Top-level keys: { Key, Start, End } (End exclusive), in file order.
  function Get-TopBlocks {
    param([string[]] $Lines)
    $blocks = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $Lines.Count; $i++) {
      $m = [regex]::Match($Lines[$i], '^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$')
      if (-not $m.Success) { continue }
      if ($blocks.Count -gt 0) { $blocks[$blocks.Count - 1].End = $i }
      $blocks.Add([pscustomobject]@{ Key = $m.Groups[1].Value; Start = $i; End = $Lines.Count; Rest = $m.Groups[2].Value })
    }
    return , $blocks
  }

  # The value of `key` in a top-level block, written either inline as a flow
  # mapping or as an indented child line. Returns @{ Value; Comment } or $null.
  function Get-ChildValue {
    param([string[]] $Lines, $Block, [string] $Key)
    $rest = (Split-Value $Block.Rest).Value
    if ($rest.StartsWith('{')) {
      $v = Get-FlowValue $rest $Key
      if ($null -eq $v) { return $null }
      return @{ Value = $v; Comment = '' }
    }
    for ($i = $Block.Start + 1; $i -lt $Block.End; $i++) {
      $m = [regex]::Match($Lines[$i], "^\s+$([regex]::Escape($Key))\s*:(.*)$")
      if ($m.Success) { return (Split-Value $m.Groups[1].Value) }
    }
    return $null
  }

  # One step of a block sequence, split into its top-level fields. Each field
  # is { Key; Header; Body }: Header is "key: rest" without indentation, Body
  # the lines under it (deeper or inert), kept verbatim. Blank lines and
  # comments after the step's last node stay after the step (Trailer).
  function Split-Step {
    param([string[]] $Lines, [int] $SeqIndent)
    $trailer = New-Object System.Collections.Generic.List[string]
    $n = $Lines.Count
    while ($n -gt 1 -and (Test-Inert $Lines[$n - 1])) { $trailer.Insert(0, $Lines[$n - 1]); $n-- }
    $Lines = [string[]] $Lines[0..($n - 1)]
    $first = $Lines[0]
    $afterDash = $first.Substring($SeqIndent + 1)
    $lead = $afterDash.Length - $afterDash.TrimStart(' ').Length
    $fields = New-Object System.Collections.Generic.List[object]
    $prefixInert = New-Object System.Collections.Generic.List[string]
    $start = 1
    $dashAlone = $afterDash.Trim() -eq ''
    if ($dashAlone) {
      # "-" on a line of its own: the mapping starts on the next node line.
      $j = 1
      while ($j -lt $Lines.Count -and (Test-Inert $Lines[$j])) { $prefixInert.Add($Lines[$j]); $j++ }
      if ($j -ge $Lines.Count) { return $null }
      $contentIndent = Get-Indent $Lines[$j]
      $headerText = $Lines[$j].Substring($contentIndent)
      $start = $j + 1
    } else {
      $contentIndent = $SeqIndent + 1 + $lead
      $headerText = $afterDash.Substring($lead)
    }
    $current = $null
    $all = New-Object System.Collections.Generic.List[string]
    $all.Add($headerText)
    for ($i = $start; $i -lt $Lines.Count; $i++) { $all.Add($Lines[$i]) }
    for ($i = 0; $i -lt $all.Count; $i++) {
      $line = $all[$i]
      $isHeader = $false
      $text = $null
      if ($i -eq 0) { $isHeader = $true; $text = $line }
      elseif (-not (Test-Inert $line) -and (Get-Indent $line) -eq $contentIndent) { $isHeader = $true; $text = $line.Substring($contentIndent) }
      elseif (-not (Test-Inert $line) -and (Get-Indent $line) -lt $contentIndent) { return $null }
      if ($isHeader) {
        $m = [regex]::Match($text, '^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$')
        if (-not $m.Success) { return $null }
        $current = [pscustomobject]@{ Key = $m.Groups[1].Value; Header = $text; Rest = $m.Groups[2].Value; Body = (New-Object System.Collections.Generic.List[string]) }
        $fields.Add($current)
      } else {
        $current.Body.Add($line)
      }
    }
    return [pscustomobject]@{ Fields = $fields; ContentIndent = $contentIndent; PrefixInert = $prefixInert; DashAlone = $dashAlone; Trailer = $trailer }
  }

  function Join-Step {
    param($Step, [int] $SeqIndent)
    $out = New-Object System.Collections.Generic.List[string]
    $pad = ' ' * $Step.ContentIndent
    for ($i = 0; $i -lt $Step.Fields.Count; $i++) {
      $f = $Step.Fields[$i]
      if ($i -eq 0) {
        if ($Step.DashAlone) {
          $out.Add((' ' * $SeqIndent) + '-')
          foreach ($l in $Step.PrefixInert) { $out.Add($l) }
          $out.Add($pad + $f.Header)
        } else {
          $out.Add((' ' * $SeqIndent) + '-' + (' ' * ($Step.ContentIndent - $SeqIndent - 1)) + $f.Header)
        }
      } else {
        $out.Add($pad + $f.Header)
      }
      foreach ($l in $f.Body) { $out.Add($l) }
    }
    foreach ($l in $Step.Trailer) { $out.Add($l) }
    return , $out
  }

  function Format-Minutes {
    param([double] $Ms)
    $min = [math]::Round($Ms / 60000, 3)
    return $min.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }

  # Convert one step's fields in place. Returns the list of changes made.
  function Convert-Step {
    param($Step, [string] $Where)
    $changes = New-Object System.Collections.Generic.List[string]
    $fields = $Step.Fields
    $byKey = @{}
    foreach ($f in $fields) { $byKey[$f.Key] = $f }
    $pad = ' ' * $Step.ContentIndent

    if ($byKey.ContainsKey('timeout_ms')) {
      $f = $byKey['timeout_ms']
      $v = Split-Value $f.Rest
      $n = 0.0
      if (-not [double]::TryParse((Get-Unquoted $v.Value), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref] $n) -or $n -le 0) {
        throw "${Where}: timeout_ms is not a number ($($v.Value))"
      }
      $minutes = Format-Minutes $n
      $f.Key = 'timeout_minutes'
      $f.Header = "timeout_minutes: $minutes$($v.Comment)"
      $changes.Add("timeout_ms: $($v.Value) -> timeout_minutes: $minutes")
    }

    if ($byKey.ContainsKey('max_retries')) {
      $f = $byKey['max_retries']
      $v = Split-Value $f.Rest
      $null = $fields.Remove($f)
      if ($byKey.ContainsKey('until')) {
        $u = $byKey['until']
        $urest = Split-Value $u.Rest
        if ($urest.Value.StartsWith('{')) {
          $flow = $urest.Value
          $close = $flow.LastIndexOf('}')
          $inner = $flow.Substring(1, $close - 1).Trim()
          $sep = ''
          if ($inner -ne '') { $sep = ', ' }
          $u.Header = "until: { $inner${sep}max_retries: $($v.Value) }$($urest.Comment)"
        } else {
          # Block mapping: add the key after its last node line, at its children's indent.
          $childIndent = $null
          $last = -1
          for ($i = 0; $i -lt $u.Body.Count; $i++) {
            if (Test-Inert $u.Body[$i]) { continue }
            if ($null -eq $childIndent) { $childIndent = Get-Indent $u.Body[$i] }
            $last = $i
          }
          if ($null -eq $childIndent) { throw "${Where}: until has no keys" }
          $u.Body.Insert($last + 1, (' ' * $childIndent) + "max_retries: $($v.Value)$($v.Comment)")
        }
        $changes.Add("max_retries: $($v.Value) -> until.max_retries: $($v.Value)")
      } else {
        $changes.Add("max_retries: $($v.Value) dropped (no until: nothing to retry)")
      }
      # The body of max_retries (comments under it) goes with it.
    }

    if ($byKey.ContainsKey('kind')) {
      $f = $byKey['kind']
      $kv = Split-Value $f.Rest
      $kind = Get-Unquoted $kv.Value
      if ($kind -ne 'pull-request') { throw "${Where}: kind: $kind is not a 2.0.0 step kind (only pull-request)" }
      $body = New-Object System.Collections.Generic.List[string]
      if ($byKey.ContainsKey('title')) {
        $t = $byKey['title']
        $body.Add("$pad  $($t.Header)")
        foreach ($l in $t.Body) {
          if ($l.Trim() -eq '') { $body.Add($l) } else { $body.Add("  $l") }
        }
        $null = $fields.Remove($t)
        $f.Header = "pull_request:$($kv.Comment)"
        $changes.Add('kind: pull-request + title -> pull_request: { title }')
      } else {
        $f.Header = "pull_request: {}$($kv.Comment)"
        $changes.Add('kind: pull-request -> pull_request: {}')
      }
      foreach ($l in $f.Body) { $body.Add($l) }
      $f.Key = 'pull_request'
      $f.Body = $body
    }
    return , $changes
  }

  function Convert-Text {
    param([string] $Text)
    $eol = "`n"
    if ($Text.Contains("`r`n")) { $eol = "`r`n" }
    $endsWithEol = $Text.EndsWith("`n")
    $body = $Text
    if ($endsWithEol) { $body = $body.Substring(0, $body.Length - 1).TrimEnd("`r") }
    $lines = [string[]] ($body -split "`r?`n")
    if ($lines | Where-Object { $_ -match "^\t" -or $_ -match "^ *\t" }) { throw 'tabs used for indentation; YAML indents with spaces' }
    $changes = New-Object System.Collections.Generic.List[string]
    $blocks = Get-TopBlocks $lines
    $byKey = @{}
    foreach ($b in $blocks) { $byKey[$b.Key] = $b }
    if (-not $byKey.ContainsKey('steps')) { throw 'no steps: (is this a workflow definition?)' }

    # --- steps -------------------------------------------------------------
    $sb = $byKey['steps']
    $stepLines = New-Object System.Collections.Generic.List[string]
    $seqIndent = $null
    $itemStarts = New-Object System.Collections.Generic.List[int]
    for ($i = $sb.Start + 1; $i -lt $sb.End; $i++) {
      $l = $lines[$i]
      if (Test-Inert $l) { continue }
      $m = [regex]::Match($l, '^( *)-(\s|$)')
      if ($null -eq $seqIndent) {
        if (-not $m.Success) { throw 'steps: is not a block list ("- id: ...")' }
        $seqIndent = $m.Groups[1].Value.Length
      }
      if ($m.Success -and $m.Groups[1].Value.Length -eq $seqIndent) { $itemStarts.Add($i) }
    }
    $newSteps = New-Object System.Collections.Generic.List[string]
    $newSteps.Add($lines[$sb.Start])
    if ($itemStarts.Count -eq 0) {
      for ($i = $sb.Start + 1; $i -lt $sb.End; $i++) { $newSteps.Add($lines[$i]) }
    } else {
      for ($i = $sb.Start + 1; $i -lt $itemStarts[0]; $i++) { $newSteps.Add($lines[$i]) }
      for ($k = 0; $k -lt $itemStarts.Count; $k++) {
        $from = $itemStarts[$k]
        $to = $sb.End
        if ($k + 1 -lt $itemStarts.Count) { $to = $itemStarts[$k + 1] }
        $item = [string[]] $lines[$from..($to - 1)]
        $where = "steps[$k]"
        if ($item[0] -match '^\s*-\s*\{') {
          if ($item[0] -match '\b(timeout_ms|max_retries|kind|title)\s*:') { throw "${where}: written as a one-line { ... } mapping; convert it by hand" }
          foreach ($l in $item) { $newSteps.Add($l) }
          continue
        }
        $step = Split-Step $item $seqIndent
        if ($null -eq $step) { throw "${where}: could not read this step's keys; convert it by hand" }
        $stepChanges = Convert-Step $step $where
        $idField = $step.Fields | Where-Object { $_.Key -eq 'id' } | Select-Object -First 1
        if ($idField) { $where = "step $(Get-Unquoted (Split-Value $idField.Rest).Value)" }
        foreach ($c in $stepChanges) { $changes.Add("${where}: $c") }
        if ($stepChanges.Count -gt 0) {
          foreach ($l in (Join-Step $step $seqIndent)) { $newSteps.Add($l) }
        } else {
          foreach ($l in $item) { $newSteps.Add($l) }
        }
      }
    }

    # --- cost / limits ---------------------------------------------------------
    $limitsLines = $null
    if ($byKey.ContainsKey('cost')) {
      $usd = Get-ChildValue $lines $byKey['cost'] 'max_usd'
      if ($null -eq $usd) { throw 'cost: has no max_usd' }
      $minutes = $null
      if ($byKey.ContainsKey('limits')) {
        $limitsBlock = $byKey['limits']
        foreach ($k in @('max_usd')) {
          if ($null -ne (Get-ChildValue $lines $limitsBlock $k)) { throw "both cost: and limits.$k are present; convert by hand" }
        }
        $minutes = Get-ChildValue $lines $limitsBlock 'max_minutes'
      }
      $limitsLines = New-Object System.Collections.Generic.List[string]
      $limitsLines.Add('limits:')
      $limitsLines.Add("  max_usd: $($usd.Value)$($usd.Comment)")
      $changes.Add("cost.max_usd: $($usd.Value) -> limits.max_usd: $($usd.Value)")
      if ($null -ne $minutes) {
        $limitsLines.Add("  max_minutes: $($minutes.Value)$($minutes.Comment)")
      } elseif (-not $NoTimeLimit) {
        $limitsLines.Add("  max_minutes: $V2DefaultMinutes")
        $changes.Add("limits.max_minutes: $V2DefaultMinutes added (2.0.0's implicit time limit; -NoTimeLimit leaves it out)")
      }
    }

    # --- reassemble ---------------------------------------------------------------
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $blocks[0].Start; $i++) { $out.Add($lines[$i]) }
    $limitsWritten = $false
    foreach ($b in $blocks) {
      $section = New-Object System.Collections.Generic.List[string]
      if ($b.Key -eq 'steps') {
        foreach ($l in $newSteps) { $section.Add($l) }
      } elseif ($null -ne $limitsLines -and ($b.Key -eq 'limits' -or $b.Key -eq 'cost')) {
        # The new limits: goes where limits: was, or where cost: was when there was none.
        $here = ($b.Key -eq 'limits') -or (-not $byKey.ContainsKey('limits'))
        if ($here -and -not $limitsWritten) {
          foreach ($l in $limitsLines) { $section.Add($l) }
          $limitsWritten = $true
        }
        # Keep what followed the block (blank lines, comments for the next key).
        $tail = New-Object System.Collections.Generic.List[string]
        for ($i = $b.End - 1; $i -gt $b.Start -and (Test-Inert $lines[$i]) -and (Get-Indent $lines[$i]) -eq 0; $i--) { $tail.Insert(0, $lines[$i]) }
        if ($here) { foreach ($l in $tail) { $section.Add($l) } }
      } else {
        for ($i = $b.Start; $i -lt $b.End; $i++) { $section.Add($lines[$i]) }
      }
      foreach ($l in $section) { $out.Add($l) }
    }
    # Removing the last block (cost:) can leave blank lines at the end.
    while ($out.Count -gt 1 -and $out[$out.Count - 1].Trim() -eq '' -and $lines[$lines.Count - 1].Trim() -ne '') { $out.RemoveAt($out.Count - 1) }
    $result = [string]::Join($eol, $out.ToArray())
    if ($endsWithEol) { $result += $eol }
    return [pscustomobject]@{ Text = $result; Changes = $changes }
  }

  # Validate with the kit's own parser and validator; $null when it passes.
  function Test-WithKit {
    param([string] $Text, [string] $Source)
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node -or -not (Test-Path -LiteralPath $WorkflowLib)) { return 'skipped' }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
      $js = "const fs=require('fs');const wf=require(process.argv[1]);try{wf.parseDefinitionText(fs.readFileSync(process.argv[2],'utf8'),process.argv[3]);}catch(e){process.stdout.write(e.message);process.exit(1);}"
      $msg = & $node.Source -e $js $WorkflowLib $tmp $Source 2>&1
      if ($LASTEXITCODE -eq 0) { return $null }
      return (($msg | Out-String).Trim())
    } finally {
      # Not Remove-Item: under -WhatIf it would only report, and leave the file behind.
      [System.IO.File]::Delete($tmp)
    }
  }
}

process {
  foreach ($p in $Path) { $inputs.Add($p) }
}

end {
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($p in $inputs) {
    if (-not (Test-Path -LiteralPath $p)) { Write-Fail "no such file or directory: $p"; $failed++; continue }
    $item = Get-Item -LiteralPath $p
    if ($item.PSIsContainer) {
      $wfDir = Join-Path (Join-Path $item.FullName '.aidev') 'workflows'
      if (Test-Path -LiteralPath $wfDir) {
        $found = @(Get-ChildItem -LiteralPath $wfDir -Directory | ForEach-Object { Join-Path $_.FullName 'workflow.yaml' } | Where-Object { Test-Path -LiteralPath $_ })
      } else {
        $found = @(Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Filter 'workflow.yaml' | Where-Object { $_.FullName -notmatch '[\\/]runs[\\/]' } | ForEach-Object { $_.FullName })
      }
      if ($found.Count -eq 0) { Write-Warn "no workflow.yaml under $p" }
      foreach ($f in $found) { $files.Add($f) }
    } else {
      $files.Add($item.FullName)
    }
  }
  if ($OutFile -and $files.Count -ne 1) { throw '-OutFile takes exactly one input file' }

  Write-Host "`nworkflow.yaml: 2.0.0 -> current`n"
  $validatorMissing = $false
  foreach ($file in $files) {
    Write-Host $file
    try {
      $text = [System.IO.File]::ReadAllText($file)
      $conv = Convert-Text $text
    } catch {
      Write-Fail $_.Exception.Message
      $failed++
      continue
    }
    if ($conv.Changes.Count -eq 0) { Write-Ok 'already in the current format; left as it is'; continue }
    foreach ($c in $conv.Changes) { Write-Note $c }

    $err = Test-WithKit $conv.Text $file
    if ($err -eq 'skipped') {
      $validatorMissing = $true
    } elseif ($null -ne $err) {
      Write-Fail "the converted definition does not validate: $err"
      if (-not $Force) { Write-Note 'not written (-Force writes it anyway)'; $failed++; continue }
    }

    $target = $file
    if ($OutFile) { $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile) }
    if ($PSCmdlet.ShouldProcess($target, 'write the converted workflow definition')) {
      if ($Backup -and $target -eq $file) { [System.IO.File]::WriteAllText("$file.v2.bak", $text, (New-Object System.Text.UTF8Encoding($false))) }
      [System.IO.File]::WriteAllText($target, $conv.Text, (New-Object System.Text.UTF8Encoding($false)))
      Write-Ok "written: $target"
    } elseif ($WhatIfPreference) {
      Write-Host ''
      Write-Host $conv.Text
    }
  }
  if ($validatorMissing) { Write-Warn 'node or the kit''s cli/lib/workflow.js was not found: not validated. Run "aidev run workflow <name> --dry-run" to check.' }
  Write-Host ''
  Write-Host 'Next: review the diff, then "aidev submit workflow <name>" to have it approved again.'
  if ($failed -gt 0) { exit 1 }
}
