This file explains how nvim is used to improve the efficacy of remote development.

# tmux
Core commands
Prefix c - new window
Prefix n - next window
Prefix p - previous window
Prefix , - rename window
Prefix % - split vertically
Prefix " - split horizontally
Prefix arrow key - move between panes
Prefix x - kill pane
Prefix d - detach
Prefix [ - scroll mode


# neovim
Open a file:

nvim path/to/file.rs
Absolute minimum keys
Modes

Neovim has modes. Only remember these first:

Normal mode - navigation/commands
Insert mode - typing text

Press:
i to enter insert mode
Esc to return to normal mode
Save and quit

In normal mode:

:w - save
:q - quit
:wq - save and quit
:q! - quit without saving
Movement

In normal mode:

h j k l - left/down/up/right
/text - search
n - next search result
gg - top of file
G - bottom of file
Edit
x - delete character
dd - delete line
yy - copy line
p - paste

# fd

Fast file discovery:

fd main
fd Cargo.toml
fd '\.rs$'
rg

Fast text search:

rg "mailboxFrozenValue"
rg "TODO"
rg "struct MyType"


