ARG ROS_DISTRO=jazzy
FROM ros:${ROS_DISTRO}-ros-base
SHELL ["/bin/bash", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    ros-${ROS_DISTRO}-rmw-cyclonedds-cpp && rm -rf /var/lib/apt/lists/*
COPY redpitaya/reader.py redpitaya/simulate.py /opt/redpitaya/
COPY redpitaya/dashboard.py /opt/redpitaya/dashboard.py
COPY redpitaya/web/ /opt/redpitaya/web/
COPY redpitaya/board/readout.py redpitaya/board/wire.py redpitaya/board/tmp451.py /opt/redpitaya/board/
CMD ["python3", "/opt/redpitaya/reader.py"]
