How public/index.html is made from the claude.ai app page:

    python3 tools/migrate_patch.py <claude-ai-page.html> /tmp/with-export.html
    python3 tools/patch.py /tmp/with-export.html public/index.html

You only need this if the app is changed again on claude.ai and you want to bring that version here.
From now on you can also just edit public/index.html directly.
