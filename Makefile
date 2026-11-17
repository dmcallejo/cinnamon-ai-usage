UUID      := ai-usage@dmcallejo
SRC       := $(CURDIR)/$(UUID)/files/$(UUID)
APPLETS   := $(HOME)/.local/share/cinnamon/applets
LOCALE    := $(HOME)/.local/share/locale
PYTHON    ?= python3
NODE      ?= node
LANGS     := $(basename $(notdir $(wildcard $(SRC)/po/*.po)))

.PHONY: help install uninstall reload translations test lint check pot

help:
	@echo "make install      Symlink the applet for development and compile translations"
	@echo "make uninstall    Remove the symlink and compiled translations"
	@echo "make reload       Reload the running applet"
	@echo "make test         Run unit tests"
	@echo "make check        Tests, syntax, JSON and translation checks"
	@echo "make pot          Regenerate the translation template"

install: translations
	mkdir -p $(APPLETS)
	ln -sfn $(SRC) $(APPLETS)/$(UUID)
	@echo "Installed. Add 'AI Usage Limits' from Panel > Applets, or run 'make reload'."

uninstall:
	rm -f $(APPLETS)/$(UUID)
	rm -f $(foreach l,$(LANGS),$(LOCALE)/$(l)/LC_MESSAGES/$(UUID).mo)

translations:
	@for l in $(LANGS); do \
		mkdir -p $(LOCALE)/$$l/LC_MESSAGES; \
		msgfmt -c $(SRC)/po/$$l.po -o $(LOCALE)/$$l/LC_MESSAGES/$(UUID).mo; \
	done

reload:
	dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
		/org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
		string:'$(UUID)' string:'APPLET'

test:
	$(NODE) --test 'tests/*.test.js'

lint:
	@for f in $$(find $(UUID) -name '*.js'); do $(NODE) --check $$f || exit 1; done
	@for f in $$(find $(UUID) -name '*.json'); do $(PYTHON) -m json.tool $$f > /dev/null || { echo "Invalid JSON: $$f"; exit 1; }; done
	@for f in $(SRC)/po/*.po; do msgfmt -c $$f -o /dev/null || exit 1; done
	@echo "Lint OK"

check: lint test

# Needs python3-polib and python3-tz (apt) for cinnamon-xlet-makepot.
pot:
	cd $(SRC) && $(PYTHON) /usr/bin/cinnamon-xlet-makepot -o po/$(UUID).pot .
	@for f in $(SRC)/po/*.po; do msgmerge -q -U --backup=none $$f $(SRC)/po/$(UUID).pot; done
