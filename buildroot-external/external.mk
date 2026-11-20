# Inclui a receita de cada pacote deste BR2_EXTERNAL (hoje não há nenhum). O sort deixa a ordem determinística,
# independente da ordem em que o sistema de arquivos devolve os nomes
include $(sort $(wildcard $(BR2_EXTERNAL_BIZAS_PATH)/package/*/*.mk))
