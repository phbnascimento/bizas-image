# Prompt padrão: diretório atual em amarelo claro e um beta em magenta e negrito, como em "~/dir β _"
# O \e e o \[ \] são do ash do BusyBox (FEATURE_EDITING_FANCY_PROMPT): o \[ \] marca o que não ocupa coluna
if [ "$PS1" ]; then
	PS1='\[\e[93m\]\w \[\e[1;35m\]β \[\e[m\]'
	export PS1
fi
