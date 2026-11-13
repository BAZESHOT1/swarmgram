CXX ?= g++
CC ?= gcc
CXXFLAGS ?= -std=c++11 -O2 -g -Wall -Wextra -Wno-unused-parameter -Iinclude -Isrc
CFLAGS ?= -O2 -g -Iinclude

CORE_SRC = \
	src/klinto_util.cpp \
	src/klinto_config.cpp \
	src/klinto_packet.cpp \
	src/klinto_codec.cpp \
	src/klinto_crypto.cpp \
	src/klinto_dedup.cpp \
	src/klinto_router.cpp \
	src/klinto_flash_queue.cpp \
	src/klinto_net.cpp \
	src/klinto_channel_plan.cpp \
	src/klinto_cell.cpp \
	src/klinto_gateway.cpp \
	src/klinto_bridge.cpp

OBJS = $(CORE_SRC:.cpp=.o) unishox2.o

.PHONY: all test clean

all: test_core

test_core: test/test_core.cpp $(OBJS)
	$(CXX) $(CXXFLAGS) $^ -o $@

unishox2.o: src/unishox2.c
	$(CC) $(CFLAGS) -c $< -o $@

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

test: test_core
	./test_core

clean:
	rm -f $(OBJS) test_core vector
