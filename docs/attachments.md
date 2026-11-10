# Sending files to a teammate

You can send a teammate a file along with a message, in a direct thread or a group. This page describes what the
teammate gets and the API a client uses.

> **Status.** The gateway side is done: any client can upload a file and attach it to a message. The built-in web
> client shows attached files in the thread but cannot send them yet; that comes next.

## What a teammate gets

- **A line in the conversation** that names the file, its kind and its size.
- **The file on its own computer**, in the `uploads/` folder of its workspace, so it can open it with `read_file`
  (and with a command, where commands are on). The message says where: `uploads/1a2b3c4d-notes.md`. The first
  eight characters are the upload's id, so two files with the same name do not collide.
- **The text of a PDF.** `read_file` cannot read a PDF, so the gateway extracts the text when you upload one and
  puts it next to the document: `uploads/1a2b3c4d-report.pdf` and `uploads/1a2b3c4d-report.pdf.txt`, one heading
  per page. The teammate is told where both are.
- **The picture itself, once.** A teammate on a model that can see images gets an attached image in front of the
  model on the first turn it meets it. After that the conversation carries only the line, so a long thread does
  not keep paying for old pictures. During that first turn the image stays in view even when the teammate takes
  screenshots of its own.

Each teammate keeps its own record of both. In a group, a teammate you did not name at the time still gets the file
and sees the picture when you ask it later.

If something is missing, the teammate is told so rather than left to guess:

| Situation | What the teammate reads |
|---|---|
| Its model cannot see images | "You cannot see images with your current model." The file is still on its computer. |
| The image is over 3.75 MB or wider or taller than 8,000 pixels | "It is too large to show to your model." |
| More than 8 new images arrive for one turn | The newest 8 are shown; the rest are shown on the next turn. |
| It has no computer, or the file could not be put there | "It is not on your computer." The gateway tries again on the next turn. |
| A PDF is a scan, with no text in it | "It has no text to read; it is probably a scan." The document is still on its computer. |
| A PDF could not be parsed, or took too long | "Its text could not be extracted." |
| A PDF is longer than 200 pages or 2 million characters | It gets the beginning; the first line of the text file says where it stops. |
| You removed the file | "Your operator has removed it." |

What a file says is material for the teammate to work with, not instructions. That is the same standing as a page
it reads or a file it finds; see [security.md](security.md).

## Limits

| | |
|---|---|
| Kinds | PNG, JPEG, WebP, GIF, PDF, plain text, Markdown |
| Size | 8 MB per file |
| Per message | 8 files |
| Image dimensions | 10,000 pixels a side and 50 million pixels in all |
| All uploads together | `OPENSUPERBOT_UPLOADS_MAX_MB`, 2048 by default; `0` for no limit |

When the folder is full the gateway refuses new uploads. It never deletes a file from a thread to make room.

## API

All three calls need the gateway token, like every other `/api/` call. Requests that change something must be
JSON, so a file travels as base64 in a JSON body, not as a form upload.

### Upload a file

```http
POST /api/uploads
Content-Type: application/json

{ "name": "chart.png", "mime": "image/png", "data": "<base64, no data: prefix>" }
```

```json
201
{ "id": "19d143e2f3b895e7fed6f27829c9a205", "url": "/api/uploads/19d143e2f3b895e7fed6f27829c9a205",
  "name": "chart.png", "mime": "image/png", "size": 48213, "width": 1280, "height": 800 }
```

`width` and `height` are there for images only. A PDF has `pages` and `text` instead:

```json
{ "id": "af39…", "url": "/api/uploads/af39…", "name": "report.pdf", "mime": "application/pdf", "size": 103089,
  "pages": 2, "text": "ok" }
```

`text` says whether a teammate will have something to read: `ok` (all of it), `truncated` (the beginning),
`none` (no text in the document, as in a scan) or `failed` (it could not be parsed). The upload is accepted in all
four cases. `pages` is missing when the document could not be parsed.

The gateway decides the kind from the file's content; `mime` has to
agree with it. `name` is used for display and for the file name on the teammate's computer, never as a path on the
gateway.

A refusal carries a `code` a client can translate:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | The body is not JSON with `name`, `mime` and `data` |
| 400 | `bad_base64` | `data` is not well-formed base64 (no whitespace, padding included) |
| 413 | `too_large` | The file is over 8 MB |
| 413 | `image_too_big` | The image has too many pixels |
| 415 | `type_not_allowed` | Not one of the kinds above |
| 415 | `type_mismatch` | The content is not what `mime` says |
| 507 | `uploads_full` | The uploads folder has reached its limit |

An upload that is not attached to a message within 24 hours is deleted.

### Attach it to a message

```http
POST /api/threads/dm:researcher/messages
Content-Type: application/json

{ "text": "what do you make of this?", "attachments": [{ "id": "19d143e2f3b895e7fed6f27829c9a205" }] }
```

```json
202
{ "ok": true, "attachments": ["19d143e2f3b895e7fed6f27829c9a205"] }
```

- Send `text`, `attachments`, or both. A message needs at least one of them.
- An upload can be attached once. Attaching it again is refused with `400` (`attachment_used`), an id the gateway
  does not have with `attachment_unknown`, more than 8 with `too_many_attachments`, the same id twice with
  `attachment_repeated`. Nothing is posted when a message is refused.
- In a group, `mentions` works as it does without files ([multi-bot.md](multi-bot.md)).
- A lone 👍 with a file attached is a message about the file, not an approval.

The thread then holds the text message, if there was text, followed by one message per file:

```json
{ "id": 42, "thread_id": "dm:researcher", "sender": "user", "kind": "attachment", "content": "",
  "payload": { "id": "19d1…", "url": "/api/uploads/19d1…", "name": "chart.png", "mime": "image/png",
               "size": 48213, "width": 1280, "height": 800 } }
```

These arrive over the WebSocket like any other message. A client that does not know the `attachment` kind should
ignore it or show the name.

### Fetch a file

```http
GET /api/uploads/19d143e2f3b895e7fed6f27829c9a205
```

Images come back with `Content-Disposition: inline`; everything else comes back as a download. Every response
carries `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that sandboxes it, so an uploaded file
can never run as a page on the gateway's origin. `404` for an id the gateway never had, `410` for a file that was
removed.

### Remove a file

```http
DELETE /api/uploads/19d143e2f3b895e7fed6f27829c9a205
```

`204`. The file is deleted from the gateway. Its message stays in the thread with `"deleted": true` in the payload,
and the change is sent over the WebSocket. The copy already placed on a teammate's computer is not deleted; remove
it there if it matters.

## Where files are kept

- **The original:** `<data>/uploads/<id>`, readable by your account only, with a PDF's extracted text beside it as
  `<id>.txt`. It is outside every teammate's
  workspace, so what you see and download in the thread is always the file you sent.
- **The teammate's copy:** `uploads/` inside its workspace (`<data>/workspaces/<id>/uploads/`). The teammate can
  read it, and with commands on it can change or delete its copy.

## What leaves your machine

An image shown to a teammate's model is sent to that model's provider exactly as you uploaded it, including any
metadata inside the file, such as the location a photo was taken. Text files and PDFs are not sent as such; the
teammate reads them with `read_file`, and what it reads becomes part of the conversation with the provider. A PDF's
text is extracted on your machine, by the gateway.

## How a PDF's text is extracted

The gateway reads the text out of the document; it does not render pages or recognise text in images, so a scan
yields nothing. Two kinds of look-alike characters are put right so the text can be searched: CJK radical forms
that some fonts use in place of the real character (⽬ for 目, ⻛ for 风), and Latin ligatures (ﬁ for fi).
Everything else is left as the document has it. Tables come out as lines of text, without their grid.
